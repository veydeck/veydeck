//! 文件路径操作协调器：统一同步保存、后台任务与上传提交的重叠保护。

use crate::{state::DbPool, types::ApiError};
use once_cell::sync::Lazy;
use sqlx::Row;
use std::{
    path::{Path, PathBuf},
    sync::Mutex as StdMutex,
};
use tokio::sync::Mutex;
use uuid::Uuid;
use veydeck_contracts::api::ErrorCode;

static ACQUIRE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static ACTIVE_RESERVATIONS: Lazy<StdMutex<Vec<ActiveReservation>>> =
    Lazy::new(|| StdMutex::new(Vec::new()));

#[derive(Debug)]
struct ActiveReservation {
    id: Uuid,
    paths: Vec<PathBuf>,
}

/// 活动路径预留；离开作用域时同步释放。
#[derive(Debug)]
pub struct FilePathReservation {
    id: Uuid,
}

impl Drop for FilePathReservation {
    fn drop(&mut self) {
        let mut reservations = ACTIVE_RESERVATIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reservations.retain(|reservation| reservation.id != self.id);
    }
}

/// 原子检查活动操作并预留路径，可忽略当前上传传输。
pub async fn reserve(
    pool: &DbPool,
    paths: Vec<PathBuf>,
    ignored_transfer_id: Option<&str>,
) -> Result<FilePathReservation, ApiError> {
    let paths = reservation_paths(paths).await?;
    if paths.is_empty() {
        return Err(ApiError::validation("file path reservation is empty"));
    }
    let _acquire_guard = ACQUIRE_LOCK.lock().await;
    ensure_no_memory_overlap(&paths)?;
    ensure_no_task_overlap(pool, &paths).await?;
    ensure_no_upload_overlap(pool, &paths, ignored_transfer_id).await?;

    let id = Uuid::now_v7();
    ACTIVE_RESERVATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(ActiveReservation { id, paths });
    Ok(FilePathReservation { id })
}

/// 判断两个路径是否具有祖先、后代或相同关系。
pub fn paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

/// 解析父路径中的链接并保留叶子身份；新建目标允许末尾父目录尚不存在。
pub async fn physical_entry_path(path: &Path) -> Result<PathBuf, ApiError> {
    let Some(parent) = path.parent() else {
        return Ok(path.to_path_buf());
    };
    let mut suffix = vec![
        path.file_name()
            .ok_or_else(|| ApiError::validation("file path has no name"))?
            .to_os_string(),
    ];
    let mut ancestor = parent;
    loop {
        match tokio::fs::canonicalize(ancestor).await {
            Ok(mut resolved) => {
                for segment in suffix.iter().rev() {
                    resolved.push(segment);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = ancestor.file_name() else {
                    return Err(crate::services::files::map_io_error(
                        error,
                        "resolve operation path",
                    ));
                };
                suffix.push(name.to_os_string());
                ancestor = ancestor.parent().unwrap_or(Path::new("/"));
            }
            Err(error) => {
                return Err(crate::services::files::map_io_error(
                    error,
                    "resolve operation path",
                ));
            }
        }
    }
}

/// 同时预留逻辑路径与物理路径，兼顾父链接变更和真实目标的重叠保护。
async fn reservation_paths(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, ApiError> {
    let mut expanded = Vec::with_capacity(paths.len() * 2);
    for path in paths {
        expanded.push(physical_entry_path(&path).await?);
        expanded.push(path);
    }
    Ok(deduplicate_paths(expanded))
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut unique = Vec::new();
    for path in paths {
        if unique.iter().any(|existing| existing == &path) {
            continue;
        }
        unique.push(path);
    }
    unique
}

fn ensure_no_memory_overlap(paths: &[PathBuf]) -> Result<(), ApiError> {
    let reservations = ACTIVE_RESERVATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if reservations.iter().any(|reservation| {
        paths.iter().any(|candidate| {
            reservation
                .paths
                .iter()
                .any(|active| paths_overlap(candidate, active))
        })
    }) {
        return Err(operation_conflict());
    }
    Ok(())
}

async fn ensure_no_task_overlap(pool: &DbPool, paths: &[PathBuf]) -> Result<(), ApiError> {
    let rows = sqlx::query(
        "SELECT item.source_path, item.target_path \
         FROM file_operation_task_items item \
         JOIN file_operation_tasks task ON task.id = item.task_id \
         WHERE task.status IN ('queued', 'running', 'cancelling')",
    )
    .fetch_all(pool)
    .await?;
    for row in rows {
        let source = PathBuf::from(row.try_get::<String, _>("source_path")?);
        let mut active_paths = vec![source];
        let target = row
            .try_get::<Option<String>, _>("target_path")?
            .map(PathBuf::from);
        active_paths.extend(target);
        let active_paths = reservation_paths(active_paths).await?;
        if paths.iter().any(|candidate| {
            active_paths
                .iter()
                .any(|active| paths_overlap(candidate, active))
        }) {
            return Err(operation_conflict());
        }
    }
    Ok(())
}

async fn ensure_no_upload_overlap(
    pool: &DbPool,
    paths: &[PathBuf],
    ignored_transfer_id: Option<&str>,
) -> Result<(), ApiError> {
    let rows = sqlx::query(
        "SELECT id, path FROM file_transfers \
         WHERE direction = 'upload' AND status IN ('created', 'receiving', 'ready')",
    )
    .fetch_all(pool)
    .await?;
    for row in rows {
        let id: String = row.try_get("id")?;
        if ignored_transfer_id == Some(id.as_str()) {
            continue;
        }
        let active = PathBuf::from(row.try_get::<String, _>("path")?);
        let active_paths = reservation_paths(vec![active]).await?;
        if paths.iter().any(|candidate| {
            active_paths
                .iter()
                .any(|active| paths_overlap(candidate, active))
        }) {
            return Err(operation_conflict());
        }
    }
    Ok(())
}

fn operation_conflict() -> ApiError {
    ApiError::conflict(
        ErrorCode::FileOperationConflict,
        "another file operation conflicts with this path",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_is_component_aware() {
        assert!(paths_overlap(Path::new("/tmp/a"), Path::new("/tmp/a/b")));
        assert!(!paths_overlap(Path::new("/tmp/a"), Path::new("/tmp/ab")));
    }

    #[tokio::test]
    async fn directory_aliases_share_reservations_but_leaf_links_keep_their_identity() {
        let pool = crate::test_support::setup_test_db().await;
        let root = std::env::temp_dir().join(format!("veydeck-alias-lock-{}", Uuid::now_v7()));
        tokio::fs::create_dir_all(root.join("actual"))
            .await
            .unwrap();
        std::os::unix::fs::symlink("actual", root.join("alias")).unwrap();
        assert_eq!(
            physical_entry_path(&root.join("alias")).await.unwrap(),
            root.join("alias")
        );
        assert_eq!(
            physical_entry_path(&root.join("alias/new/sub/file"))
                .await
                .unwrap(),
            root.join("actual/new/sub/file")
        );
        let guard = reserve(&pool, vec![root.join("alias/file")], None)
            .await
            .unwrap();
        assert_eq!(
            reserve(&pool, vec![root.join("actual/file")], None)
                .await
                .unwrap_err()
                .code,
            ErrorCode::FileOperationConflict
        );
        assert_eq!(
            reserve(&pool, vec![root.join("alias")], None)
                .await
                .unwrap_err()
                .code,
            ErrorCode::FileOperationConflict
        );
        drop(guard);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn active_reservation_blocks_overlap_until_drop() {
        let pool = crate::test_support::setup_test_db().await;
        let first = reserve(&pool, vec![PathBuf::from("/tmp/a")], None)
            .await
            .unwrap();

        let error = reserve(&pool, vec![PathBuf::from("/tmp/a/child")], None)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::FileOperationConflict);

        drop(first);
        reserve(&pool, vec![PathBuf::from("/tmp/a/child")], None)
            .await
            .unwrap();
    }
}
