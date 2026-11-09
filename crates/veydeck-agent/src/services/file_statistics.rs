//! 属性窗口的临时目录统计：有界并发、取消、空闲回收与不跟随内部链接的扫描。

use super::files;
use crate::types::{ApiError, ApiResult};
use axum::http::StatusCode;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, Metadata},
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use veydeck_contracts::{
    api::ErrorCode,
    files::{CreateFileStatisticsRequest, FileStatistics, FileStatisticsError, FileStatisticsStatus},
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const RESULT_TTL: Duration = Duration::from_secs(120);
const MAX_SESSIONS: usize = 64;
static SERVICE: LazyLock<StatisticsService> = LazyLock::new(StatisticsService::default);

/// 一个查询的当前累计值及租约，取消令牌供阻塞扫描器协作检查。
struct Session {
    view: FileStatistics,
    used_at: Instant,
    finished_at: Option<Instant>,
    cancellation: CancellationToken,
}

/// 独立注册表便于测试，不与文件变更任务共用数据库或任务中心。
#[derive(Clone)]
struct StatisticsService {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    permits: Arc<Semaphore>,
}

impl Default for StatisticsService {
    fn default() -> Self {
        Self {
            sessions: Arc::default(),
            permits: Arc::new(Semaphore::new(2)),
        }
    }
}

/// 创建目录统计，先校验链接自身版本，再固定本次根目录目标。
pub async fn create(request: CreateFileStatisticsRequest) -> ApiResult<FileStatistics> {
    SERVICE.create(request).await
}

/// 获取统计并续租；过期查询必须由用户显式重新发起。
pub fn get(id: &str) -> ApiResult<FileStatistics> {
    SERVICE.get(id, false)
}

/// 请求停止查询，终态由扫描器确认，不把请求接受误报成已取消。
pub fn cancel(id: &str) -> ApiResult<FileStatistics> {
    SERVICE.get(id, true)
}

impl StatisticsService {
    /// 创建有界内存查询，并以独立租约看门狗回收无订阅者扫描。
    async fn create(&self, request: CreateFileStatisticsRequest) -> ApiResult<FileStatistics> {
        let permit = self.permits.clone().try_acquire_owned().map_err(|_| busy())?;
        let path = files::normalize_absolute_path(&request.path)?;
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|error| files::map_io_error(error, "inspect statistics source"))?;
        if files::revision(&metadata) != request.expected_revision {
            return Err(ApiError::conflict(ErrorCode::FileChanged, "statistics source changed"));
        }
        let target = tokio::fs::canonicalize(&path)
            .await
            .map_err(|error| files::map_io_error(error, "resolve statistics directory"))?;
        let root = tokio::fs::metadata(&target)
            .await
            .map_err(|error| files::map_io_error(error, "inspect statistics directory"))?;
        if !root.is_dir() {
            return Err(ApiError::validation("statistics source must be a directory"));
        }
        let latest = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|error| files::map_io_error(error, "verify statistics source"))?;
        if files::revision(&latest) != request.expected_revision {
            return Err(ApiError::conflict(ErrorCode::FileChanged, "statistics source changed"));
        }
        let id = Uuid::now_v7().to_string();
        let view = FileStatistics {
            id: id.clone(),
            path: path.to_string_lossy().into_owned(),
            status: FileStatisticsStatus::Running,
            file_count: 0,
            directory_count: 0,
            symlink_count: 0,
            logical_bytes: 0,
            allocated_bytes: 0,
            skipped_mount_count: 0,
            unreadable_count: 0,
            vanished_count: 0,
            special_count: 0,
            partial: false,
            errors: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
        };
        let session = Arc::new(Mutex::new(Session {
            view: view.clone(),
            used_at: Instant::now(),
            finished_at: None,
            cancellation: CancellationToken::new(),
        }));
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.retain(|_, entry| {
                entry.lock().unwrap().finished_at.is_none_or(|time| time.elapsed() < RESULT_TTL)
            });
            if sessions.len() >= MAX_SESSIONS {
                let oldest = sessions.iter()
                    .filter_map(|(id, entry)| entry.lock().unwrap().finished_at.map(|time| (id.clone(), time)))
                    .min_by_key(|(_, time)| *time)
                    .map(|(id, _)| id);
                if let Some(id) = oldest { sessions.remove(&id); } else { return Err(busy()); }
            }
            sessions.insert(id.clone(), session.clone());
        }
        let worker_session = session.clone();
        tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                scan(&target, &root, &worker_session);
            }).await;
            if result.is_err() {
                finish(&session, FileStatisticsStatus::Failed);
            }
        });
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if service.maintain(&id) { return; }
            }
        });
        Ok(view)
    }

    /// 看门狗与测试共用租约判定；终态保留期结束后真正释放注册表引用。
    fn maintain(&self, id: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(session) = sessions.get(id) else { return true; };
        let remove = {
            let mut session = session.lock().unwrap();
            if session.finished_at.is_some_and(|time| time.elapsed() >= RESULT_TTL) {
                true
            } else {
                if session.finished_at.is_none() && session.used_at.elapsed() >= IDLE_TIMEOUT {
                    session.cancellation.cancel();
                    session.view.status = FileStatisticsStatus::Cancelling;
                }
                false
            }
        };
        if remove { sessions.remove(id); }
        remove
    }

    /// 续租与取消均在同一把状态锁内完成，避免覆盖扫描器已确认的终态。
    fn get(&self, id: &str, cancel: bool) -> ApiResult<FileStatistics> {
        let session = self.sessions.lock().unwrap().get(id).cloned().ok_or_else(expired)?;
        let mut session = session.lock().unwrap();
        if session.finished_at.is_some_and(|time| time.elapsed() >= RESULT_TTL) {
            return Err(expired());
        }
        session.used_at = Instant::now();
        if cancel && session.finished_at.is_none() {
            session.cancellation.cancel();
            session.view.status = FileStatisticsStatus::Cancelling;
        }
        Ok(session.view.clone())
    }
}

/// 扫描线程只读属性，不打开普通文件内容；目录通过 O_NOFOLLOW 固定句柄后再枚举。
fn scan(root_path: &Path, root: &Metadata, session: &Arc<Mutex<Session>>) {
    scan_on_device(root_path, root, root.dev(), session);
}

/// 根目录身份与文件系统边界独立校验，避免跨设备遍历和目录身份替换。
fn scan_on_device(root_path: &Path, root: &Metadata, device: u64, session: &Arc<Mutex<Session>>) {
    let cancellation = session.lock().unwrap().cancellation.clone();
    let mut stack = vec![(root_path.to_path_buf(), PathBuf::new(), root.dev(), root.ino())];
    let mut allocated_inodes = HashSet::from([(root.dev(), root.ino())]);
    session.lock().unwrap().view.allocated_bytes = root.blocks().saturating_mul(512);
    while let Some((path, relative, expected_dev, expected_ino)) = stack.pop() {
        if cancellation.is_cancelled() { break; }
        let directory = match fs::OpenOptions::new().read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(&path)
        {
            Ok(directory) => directory,
            Err(error) => { record_error(session, &relative, error); continue; }
        };
        let current = match directory.metadata() {
            Ok(metadata) => metadata,
            Err(error) => { record_error(session, &relative, error); continue; }
        };
        if current.dev() != expected_dev || current.ino() != expected_ino {
            record_error(session, &relative, io::Error::from(io::ErrorKind::NotFound));
            continue;
        }
        use std::os::fd::AsRawFd;
        let descriptor_path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        let reader = match fs::read_dir(&descriptor_path) {
            Ok(reader) => reader,
            Err(error) => { record_error(session, &relative, error); continue; }
        };
        for entry in reader {
            if cancellation.is_cancelled() { break; }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => { record_error(session, &relative, error); continue; }
            };
            let child_relative = relative.join(entry.file_name());
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) => { record_error(session, &child_relative, error); continue; }
            };
            let mut state = session.lock().unwrap();
            let view = &mut state.view;
            if metadata.is_dir() && (metadata.dev() != device || allocated_inodes.contains(&(metadata.dev(), metadata.ino()))) {
                view.skipped_mount_count += 1;
                view.partial = true;
                continue;
            }
            if metadata.is_dir() {
                view.directory_count += 1;
                stack.push((root_path.join(&child_relative), child_relative, metadata.dev(), metadata.ino()));
            } else if metadata.is_file() {
                view.file_count += 1;
                view.logical_bytes = view.logical_bytes.saturating_add(metadata.len());
            } else if metadata.file_type().is_symlink() {
                view.symlink_count += 1;
            } else {
                view.special_count += 1;
                view.partial = true;
                continue;
            }
            // 目录身份用于阻止绑定挂载环；普通文件仅对多硬链接 inode 保留去重记录。
            if (!metadata.is_dir() && metadata.nlink() <= 1)
                || allocated_inodes.insert((metadata.dev(), metadata.ino()))
            {
                view.allocated_bytes = view.allocated_bytes.saturating_add(metadata.blocks().saturating_mul(512));
            }
        }
    }
    finish(session, FileStatisticsStatus::Succeeded);
}

/// 保存有限错误样本，计数不会因样本上限而丢失。
fn record_error(session: &Arc<Mutex<Session>>, relative: &Path, error: io::Error) {
    let mut session = session.lock().unwrap();
    let view = &mut session.view;
    if error.kind() == io::ErrorKind::NotFound { view.vanished_count += 1; }
    else { view.unreadable_count += 1; }
    view.partial = true;
    if view.errors.len() < 10 {
        view.errors.push(FileStatisticsError {
            path: Path::new(&view.path).join(relative).to_string_lossy().into_owned(),
            code: files::map_io_error(error, "scan directory statistics").code,
        });
    }
}

/// 终态在取消令牌检查之后一次性确认，取消与扫描结束的竞争由状态锁排序。
fn finish(session: &Arc<Mutex<Session>>, status: FileStatisticsStatus) {
    let mut session = session.lock().unwrap();
    session.view.status = if session.cancellation.is_cancelled() {
        FileStatisticsStatus::Cancelled
    } else { status };
    session.view.finished_at = Some(chrono::Utc::now().to_rfc3339());
    session.finished_at = Some(Instant::now());
}

/// 统一返回可重试的统计并发冲突。
fn busy() -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, ErrorCode::FileStatisticsBusy, "directory statistics busy")
}

/// 过期与不存在的统计均要求客户端重新计算。
fn expired() -> ApiError {
    ApiError::new(StatusCode::GONE, ErrorCode::FileStatisticsExpired, "directory statistics expired")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// 自动释放测试目录，避免修改真实用户目录与挂载配置。
    struct Directory(PathBuf);
    impl Directory {
        /// 创建隔离的统计样本根目录。
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("veydeck-properties-{}", Uuid::now_v7()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        /// 使用当前路径自身的版本构造统计请求。
        fn request(&self) -> CreateFileStatisticsRequest {
            CreateFileStatisticsRequest {
                path: self.0.to_string_lossy().into_owned(),
                expected_revision: files::revision(&fs::symlink_metadata(&self.0).unwrap()),
            }
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    /// 等待真正扫描终态，不以创建或取消接口返回代替终态。
    async fn complete(service: &StatisticsService, id: &str) -> FileStatistics {
        for _ in 0..1000 {
            let value = service.get(id, false).unwrap();
            if !matches!(value.status, FileStatisticsStatus::Running | FileStatisticsStatus::Cancelling) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("statistics did not finish");
    }

    #[tokio::test]
    async fn counts_regular_files_without_following_links_and_deduplicates_allocated_blocks() {
        let root = Directory::new();
        fs::create_dir(root.0.join("nested")).unwrap();
        let file = root.0.join("data");
        fs::write(&file, b"hello").unwrap();
        fs::hard_link(&file, root.0.join("hard-link")).unwrap();
        fs::File::create(root.0.join("empty")).unwrap();
        let sparse = fs::File::create(root.0.join("nested/sparse")).unwrap();
        sparse.set_len(16 * 1024 * 1024).unwrap();
        symlink("nested", root.0.join("directory-link")).unwrap();
        symlink("missing", root.0.join("broken")).unwrap();
        let service = StatisticsService::default();
        let created = service.create(root.request()).await.unwrap();
        let result = complete(&service, &created.id).await;
        assert_eq!(result.status, FileStatisticsStatus::Succeeded);
        assert_eq!(result.file_count, 4);
        assert_eq!(result.directory_count, 1);
        assert_eq!(result.symlink_count, 2);
        assert_eq!(result.logical_bytes, 16 * 1024 * 1024 + 10);
        let expected_blocks: u64 = ["", "nested", "data", "empty", "nested/sparse", "directory-link", "broken"]
            .iter().map(|name| fs::symlink_metadata(root.0.join(name)).unwrap().blocks()).sum();
        assert_eq!(result.allocated_bytes, expected_blocks * 512);
        assert!(!result.partial);
    }

    #[tokio::test]
    async fn validates_revision_and_type_and_preserves_logical_root_link() {
        let root = Directory::new();
        fs::create_dir(root.0.join("actual")).unwrap();
        symlink("actual", root.0.join("alias")).unwrap();
        let link = root.0.join("alias");
        let service = StatisticsService::default();
        let result = service.create(CreateFileStatisticsRequest {
            path: link.to_string_lossy().into_owned(),
            expected_revision: files::revision(&fs::symlink_metadata(&link).unwrap()),
        }).await.unwrap();
        assert_eq!(complete(&service, &result.id).await.path, link.to_string_lossy());
        let mut stale = root.request();
        stale.expected_revision = "stale".into();
        assert_eq!(service.create(stale).await.unwrap_err().code, ErrorCode::FileChanged);
        let file = root.0.join("file");
        fs::write(&file, b"test").unwrap();
        assert!(service.create(CreateFileStatisticsRequest {
            path: file.to_string_lossy().into_owned(),
            expected_revision: files::revision(&fs::metadata(&file).unwrap()),
        }).await.is_err());
    }

    #[tokio::test]
    async fn concurrency_limit_cancellation_lease_and_result_expiry_are_bounded() {
        let root = Directory::new();
        let service = StatisticsService::default();
        let permit = service.permits.clone().acquire_many_owned(2).await.unwrap();
        assert_eq!(service.create(root.request()).await.unwrap_err().status, StatusCode::TOO_MANY_REQUESTS);
        drop(permit);
        let created = service.create(root.request()).await.unwrap();
        complete(&service, &created.id).await;
        let session = service.sessions.lock().unwrap()[&created.id].clone();
        {
            let mut session = session.lock().unwrap();
            session.finished_at = None;
            session.view.status = FileStatisticsStatus::Running;
            session.used_at = Instant::now() - IDLE_TIMEOUT;
        }
        assert!(!service.maintain(&created.id));
        assert_eq!(service.get(&created.id, false).unwrap().status, FileStatisticsStatus::Cancelling);
        finish(&session, FileStatisticsStatus::Succeeded);
        assert_eq!(service.get(&created.id, false).unwrap().status, FileStatisticsStatus::Cancelled);
        assert_eq!(service.get(&created.id, true).unwrap().status, FileStatisticsStatus::Cancelled);
        session.lock().unwrap().finished_at = Some(Instant::now() - RESULT_TTL);
        assert!(service.get(&created.id, false).is_err());
        assert!(service.maintain(&created.id));
        assert!(service.sessions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn errors_are_partial_bounded_and_use_logical_paths() {
        let root = Directory::new();
        let service = StatisticsService::default();
        let created = service.create(root.request()).await.unwrap();
        complete(&service, &created.id).await;
        let session = service.sessions.lock().unwrap()[&created.id].clone();
        for _ in 0..15 {
            record_error(&session, Path::new("missing"), io::Error::from(io::ErrorKind::NotFound));
        }
        record_error(&session, Path::new("private"), io::Error::from(io::ErrorKind::PermissionDenied));
        let result = service.get(&created.id, false).unwrap();
        assert!(result.partial);
        assert_eq!(result.vanished_count, 15);
        assert_eq!(result.unreadable_count, 1);
        assert_eq!(result.errors.len(), 10);
        assert_eq!(result.errors[0].path, root.0.join("missing").to_string_lossy());
    }

    #[tokio::test]
    async fn cancelled_scans_do_not_read_directory_entries() {
        let root = Directory::new();
        let service = StatisticsService::default();
        let created = service.create(root.request()).await.unwrap();
        complete(&service, &created.id).await;
        fs::write(root.0.join("must-not-be-counted"), b"test").unwrap();
        let session = service.sessions.lock().unwrap()[&created.id].clone();
        session.lock().unwrap().cancellation.cancel();
        scan(&root.0, &fs::metadata(&root.0).unwrap(), &session);
        let result = service.get(&created.id, false).unwrap();
        assert_eq!(result.file_count, 0);
        assert_eq!(result.status, FileStatisticsStatus::Cancelled);
    }

    #[tokio::test]
    async fn filesystem_boundary_skips_descendants_and_marks_partial_results() {
        let root = Directory::new();
        let service = StatisticsService::default();
        let created = service.create(root.request()).await.unwrap();
        complete(&service, &created.id).await;
        fs::create_dir(root.0.join("other-device")).unwrap();
        fs::write(root.0.join("other-device/not-scanned"), b"excluded").unwrap();
        let session = service.sessions.lock().unwrap()[&created.id].clone();
        let metadata = fs::metadata(&root.0).unwrap();
        // 注入与样本子目录不同的文件系统边界，不要求测试进程具备 mount 权限。
        scan_on_device(&root.0, &metadata, metadata.dev().wrapping_add(1), &session);
        let result = service.get(&created.id, false).unwrap();
        assert_eq!(result.skipped_mount_count, 1);
        assert_eq!(result.file_count, 0);
        assert_eq!(result.logical_bytes, 0);
        assert!(result.partial);
    }
}
