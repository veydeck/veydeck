//! 文件管理同步领域：路径校验、元数据、分页、文本读取与原子写入。

use crate::{config, services::file_path_coordinator, state::DbPool, types::ApiError};
use axum::http::StatusCode;
use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::Row;
use std::{
    cmp::Ordering,
    ffi::CString,
    io,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;
use veydeck_contracts::{
    api::ErrorCode,
    files::{
        FileCapabilities, FileDocument, FileEntryCounts, FileEntryDetail, FileEntryKind,
        FileEntrySummary, FileHome, FileListPage, FileManagement, FileManagementKind,
        FileSaveDurability, FileSaveResult,
    },
};

/// 文本读取与保存的最大 UTF-8 字节数。
pub const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
pub const DEFAULT_PAGE_SIZE: u32 = 50;
pub const MAX_PAGE_SIZE: u32 = 500;

/// 文件列表排序字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileSortBy {
    Name,
    ModifiedAt,
    SizeBytes,
}

/// 文件列表排序方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileSortOrder {
    Asc,
    Desc,
}

/// 已校验的目录列表参数。
pub struct FileListOptions {
    pub path: PathBuf,
    pub page: u32,
    pub page_size: u32,
    pub sort_by: FileSortBy,
    pub sort_order: FileSortOrder,
    pub show_hidden: bool,
    /// 后续分页复用的目录快照；空值创建新快照。
    pub snapshot_id: Option<String>,
}

/// Agent 内存快照预算；过期和淘汰均不静默重建分页。
const SNAPSHOT_MAX_BYTES: usize = 64 * 1024 * 1024;
const SNAPSHOT_MAX_COUNT: usize = 16;
const SNAPSHOT_IDLE: Duration = Duration::from_secs(120);
static SNAPSHOT_SCAN: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
static DIRECTORY_SNAPSHOTS: LazyLock<Mutex<SnapshotCache>> =
    LazyLock::new(|| Mutex::new(SnapshotCache::default()));

/// 一次目录扫描的不可变、已排序结果。
struct DirectorySnapshot {
    id: String,
    path: PathBuf,
    sort_by: FileSortBy,
    sort_order: FileSortOrder,
    show_hidden: bool,
    entries: Vec<FileEntrySummary>,
    counts: FileEntryCounts,
    loaded_at: String,
    bytes: usize,
}
impl DirectorySnapshot {
    /// 只克隆当前页，分页不会重新访问目录中的文件。
    fn page(&self, options: &FileListOptions) -> FileListPage {
        let start = ((options.page - 1) as usize)
            .saturating_mul(options.page_size as usize)
            .min(self.entries.len());
        let end = start
            .saturating_add(options.page_size as usize)
            .min(self.entries.len());
        FileListPage {
            snapshot_id: self.id.clone(),
            path: self.path.to_string_lossy().into_owned(),
            entries: self.entries[start..end].to_vec(),
            page: options.page,
            page_size: options.page_size,
            total: self.entries.len() as u64,
            counts: self.counts.clone(),
            loaded_at: self.loaded_at.clone(),
        }
    }
}

/// 带空闲过期和 LRU 淘汰的有界目录缓存。
#[derive(Default)]
struct SnapshotCache {
    entries: Vec<(Arc<DirectorySnapshot>, Instant)>,
}
impl SnapshotCache {
    /// 移除空闲过期快照。
    fn expire(&mut self) {
        self.entries
            .retain(|(_, used)| used.elapsed() < SNAPSHOT_IDLE);
    }
    /// 获取并延长快照空闲期限。
    fn get(&mut self, id: &str) -> Result<Arc<DirectorySnapshot>, ApiError> {
        self.expire();
        let Some((snapshot, used)) = self.entries.iter_mut().find(|(s, _)| s.id == id) else {
            return Err(ApiError::new(
                StatusCode::GONE,
                ErrorCode::FileListSnapshotExpired,
                "directory snapshot expired",
            ));
        };
        *used = Instant::now();
        Ok(snapshot.clone())
    }
    /// 按数量与内存双重预算淘汰最久未使用的快照。
    fn insert(&mut self, snapshot: DirectorySnapshot) -> Result<(), ApiError> {
        if snapshot.bytes > SNAPSHOT_MAX_BYTES {
            return Err(snapshot_limit());
        }
        self.expire();
        while self.entries.len() >= SNAPSHOT_MAX_COUNT
            || self.entries.iter().map(|(s, _)| s.bytes).sum::<usize>() + snapshot.bytes
                > SNAPSHOT_MAX_BYTES
        {
            let oldest = self
                .entries
                .iter()
                .enumerate()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(i, _)| i)
                .unwrap();
            self.entries.remove(oldest);
        }
        self.entries.push((Arc::new(snapshot), Instant::now()));
        Ok(())
    }
}
/// 返回可识别的快照资源上限错误。
fn snapshot_limit() -> ApiError {
    ApiError::new(
        StatusCode::INSUFFICIENT_STORAGE,
        ErrorCode::FileListSnapshotLimit,
        "directory snapshot capacity exceeded",
    )
}

#[derive(Debug, Clone)]
struct ManagementRoot {
    path: PathBuf,
    kind: FileManagementKind,
    owner_name: Option<String>,
    manage_via: &'static str,
}

/// 校验并进行纯词法规范化；文件管理允许访问任意绝对路径。
pub fn normalize_absolute_path(value: &str) -> Result<PathBuf, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.as_bytes().contains(&0) {
        return Err(invalid_path("path must not be empty or contain NUL"));
    }
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(invalid_path(
            "path must be absolute and must not contain parent references",
        ));
    }
    let mut normalized = PathBuf::from("/");
    for component in path.components() {
        if let Component::Normal(segment) = component {
            normalized.push(segment);
        }
    }
    Ok(normalized)
}

/// 返回 Agent 有效主目录。
pub fn home() -> FileHome {
    let path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    FileHome {
        path: path.to_string_lossy().into_owned(),
    }
}

/// 返回稳定排序并分页的当前目录摘要。
pub async fn list(pool: &DbPool, options: FileListOptions) -> Result<FileListPage, ApiError> {
    let metadata = tokio::fs::metadata(&options.path)
        .await
        .map_err(|error| map_io_error(error, "list directory"))?;
    if !metadata.is_dir() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::FileTypeUnsupported,
            "path is not a directory",
        ));
    }

    if let Some(id) = options.snapshot_id.as_deref().filter(|id| !id.is_empty()) {
        let snapshot = DIRECTORY_SNAPSHOTS.lock().unwrap().get(id)?;
        if snapshot.path != options.path
            || snapshot.sort_by != options.sort_by
            || snapshot.sort_order != options.sort_order
            || snapshot.show_hidden != options.show_hidden
        {
            return Err(ApiError::validation("snapshot parameters do not match"));
        }
        return Ok(snapshot.page(&options));
    }
    // 串行建立快照，避免多个大目录扫描同时占用不受限的临时内存。
    let _scan = SNAPSHOT_SCAN
        .acquire()
        .await
        .map_err(|_| snapshot_limit())?;
    let roots = management_roots(pool).await?;
    let mut estimated_bytes = 0;
    let mut counts = FileEntryCounts::default();
    let mut entries = Vec::new();
    let mut reader = tokio::fs::read_dir(&options.path)
        .await
        .map_err(|error| map_io_error(error, "open directory"))?;
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| map_io_error(error, "read directory"))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !options.show_hidden && name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|error| map_io_error(error, "read file metadata"))?;
        let summary = summary_from_metadata(&path, name, &metadata, &roots);
        match summary.kind {
            FileEntryKind::File => counts.file_count += 1,
            FileEntryKind::Directory => counts.directory_count += 1,
            FileEntryKind::Symlink => counts.symlink_count += 1,
            FileEntryKind::Other => counts.other_count += 1,
        }
        estimated_bytes += std::mem::size_of::<FileEntrySummary>()
            + summary.path.len()
            + summary.name.len()
            + summary.revision.len()
            + summary
                .management
                .owner_name
                .as_ref()
                .map_or(0, String::len)
            + summary
                .management
                .manage_via
                .as_ref()
                .map_or(0, String::len)
            + 128;
        if estimated_bytes > SNAPSHOT_MAX_BYTES {
            return Err(snapshot_limit());
        }
        entries.push(summary);
    }

    entries.sort_by(|left, right| compare_entries(left, right, &options));
    let snapshot = DirectorySnapshot {
        id: Uuid::now_v7().to_string(),
        path: options.path.clone(),
        sort_by: options.sort_by,
        sort_order: options.sort_order,
        show_hidden: options.show_hidden,
        counts,
        loaded_at: timestamp(SystemTime::now()).unwrap_or_default(),
        entries,
        bytes: estimated_bytes,
    };
    let page = snapshot.page(&options);
    DIRECTORY_SNAPSHOTS.lock().unwrap().insert(snapshot)?;
    Ok(page)
}

/// 返回单个文件系统条目的按需详情。
pub async fn detail(pool: &DbPool, path: &Path) -> Result<FileEntryDetail, ApiError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| map_io_error(error, "read file metadata"))?;
    let roots = management_roots(pool).await?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string());
    let symlink_target = if metadata.file_type().is_symlink() {
        Some(
            tokio::fs::read_link(path)
                .await
                .map_err(|error| map_io_error(error, "read symbolic link"))?
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        None
    };
    let (symlink_target_kind, symlink_target_capabilities, symlink_error) =
        if symlink_target.is_some() {
            match tokio::fs::metadata(path).await {
                Ok(target) => {
                    let target_kind = kind(&target);
                    (
                        Some(target_kind),
                        Some(capabilities_from_metadata(target_kind, &target)),
                        None,
                    )
                }
                Err(error) => (
                    None,
                    None,
                    Some(map_io_error(error, "resolve symbolic link").code),
                ),
            }
        } else {
            (None, None, None)
        };
    Ok(FileEntryDetail {
        summary: summary_from_metadata(path, name, &metadata, &roots),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        user_name: None,
        group_name: None,
        symlink_target,
        symlink_target_kind,
        symlink_target_capabilities,
        symlink_error,
    })
}

/// 读取有限大小的 UTF-8 普通文件，符号链接会解析到最终目标。
pub async fn read_content(path: &Path) -> Result<FileDocument, ApiError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| map_io_error(error, "open text file"))?;
    let initial_metadata = file
        .metadata()
        .await
        .map_err(|error| map_io_error(error, "read file metadata"))?;
    ensure_regular_file(&initial_metadata)?;
    if initial_metadata.len() > MAX_TEXT_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::FileContentTooLarge,
            "text file exceeds the 4 MiB editor limit",
        ));
    }
    let mut bytes = Vec::with_capacity(initial_metadata.len() as usize);
    (&mut file)
        .take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| map_io_error(error, "read file"))?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::FileContentTooLarge,
            "text file exceeds the 4 MiB editor limit",
        ));
    }
    let metadata = file
        .metadata()
        .await
        .map_err(|error| map_io_error(error, "recheck file metadata"))?;
    if revision(&metadata) != revision(&initial_metadata) {
        return Err(ApiError::conflict(
            ErrorCode::FileChanged,
            "file changed while it was being read",
        ));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::FileTypeUnsupported,
            "file content is not UTF-8 text",
        )
    })?;
    Ok(FileDocument {
        path: path.to_string_lossy().into_owned(),
        size_bytes: metadata.len(),
        revision: revision(&metadata),
        modified_at: metadata.modified().ok().and_then(timestamp),
        content,
        encoding: "utf8".to_string(),
        loaded_at: now_timestamp(),
        capabilities: capabilities_from_metadata(FileEntryKind::File, &metadata),
    })
}

/// 以排他方式创建普通文件，不隐式创建父目录。
pub async fn create_file(
    pool: &DbPool,
    path: &Path,
    content: &str,
) -> Result<FileEntryDetail, ApiError> {
    ensure_text_size(content)?;
    let mut options = tokio::fs::OpenOptions::new();
    let mut file = options
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| map_io_error(error, "create file"))?;
    if let Err(error) = file.write_all(content.as_bytes()).await {
        drop(file);
        let _ = tokio::fs::remove_file(path).await;
        return Err(map_io_error(error, "write new file"));
    }
    if let Err(error) = file.sync_all().await {
        drop(file);
        let _ = tokio::fs::remove_file(path).await;
        return Err(map_io_error(error, "sync new file"));
    }
    detail(pool, path).await
}

/// 创建目录，可选择递归创建父目录。
pub async fn create_directory(
    pool: &DbPool,
    path: &Path,
    recursive: bool,
) -> Result<FileEntryDetail, ApiError> {
    if tokio::fs::symlink_metadata(path).await.is_ok() {
        return Err(ApiError::conflict(
            ErrorCode::FileAlreadyExists,
            "target file or directory already exists",
        ));
    }
    if !recursive {
        tokio::fs::create_dir(path)
            .await
            .map_err(|error| map_io_error(error, "create directory"))?;
        return detail(pool, path).await;
    }

    let mut missing = Vec::new();
    let mut cursor = path;
    while tokio::fs::symlink_metadata(cursor).await.is_err() {
        missing.push(cursor.to_path_buf());
        cursor = cursor
            .parent()
            .ok_or_else(|| invalid_path("directory has no existing parent"))?;
    }
    let mut created = Vec::new();
    for directory in missing.into_iter().rev() {
        if let Err(error) = tokio::fs::create_dir(&directory).await {
            for created_directory in created.into_iter().rev() {
                let _ = tokio::fs::remove_dir(created_directory).await;
            }
            return Err(map_io_error(error, "create directory"));
        }
        created.push(directory);
    }
    detail(pool, path).await
}

/// 使用同目录临时文件和 revision 校验原子更新文本内容。
pub async fn update_content(
    pool: &DbPool,
    path: &Path,
    content: &str,
    expected_revision: &str,
) -> Result<FileSaveResult, ApiError> {
    ensure_text_size(content)?;
    let target = if tokio::fs::symlink_metadata(path)
        .await
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        tokio::fs::canonicalize(path)
            .await
            .map_err(|error| map_io_error(error, "resolve symbolic link"))?
    } else {
        path.to_path_buf()
    };
    let _path_reservation =
        file_path_coordinator::reserve(pool, vec![target.clone()], None).await?;
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|error| map_io_error(error, "read file metadata"))?;
    ensure_regular_file(&metadata)?;
    ensure_single_link(&metadata)?;
    if revision(&metadata) != expected_revision {
        return Err(ApiError::conflict(
            ErrorCode::FileChanged,
            "file changed since it was loaded",
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| invalid_path("file has no parent"))?;
    let temporary = parent.join(format!(".veydeck-write-{}", Uuid::now_v7()));
    let result = write_temporary(&temporary, &target, &metadata, content).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    let (committed_metadata, durability) = result?;
    Ok(FileSaveResult {
        document: document_from_content(path, content, &committed_metadata),
        durability,
    })
}

async fn write_temporary(
    temporary: &Path,
    target: &Path,
    metadata: &std::fs::Metadata,
    content: &str,
) -> Result<(std::fs::Metadata, FileSaveDurability), ApiError> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .await
        .map_err(|error| map_io_error(error, "create temporary file"))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|error| map_io_error(error, "write temporary file"))?;
    preserve_owner(temporary, metadata.uid(), metadata.gid())?;
    tokio::fs::set_permissions(temporary, metadata.permissions())
        .await
        .map_err(|error| metadata_preservation_error(error, "preserve file mode"))?;
    preserve_extended_attributes(target, temporary).await?;
    file.sync_all()
        .await
        .map_err(|error| map_io_error(error, "sync temporary file"))?;
    let committed_metadata = file
        .metadata()
        .await
        .map_err(|error| map_io_error(error, "read temporary file metadata"))?;
    let current = tokio::fs::metadata(target)
        .await
        .map_err(|error| map_io_error(error, "recheck file metadata"))?;
    if revision(&current) != revision(metadata) {
        return Err(ApiError::conflict(
            ErrorCode::FileChanged,
            "file changed while it was being saved",
        ));
    }
    ensure_single_link(&current)?;
    tokio::fs::rename(temporary, target)
        .await
        .map_err(|error| map_io_error(error, "commit file update"))?;
    let durability = save_durability(
        sync_directory(target.parent().unwrap_or(Path::new("/"))).await,
        target,
    );
    Ok((committed_metadata, durability))
}

fn save_durability(directory_sync: Result<(), ApiError>, target: &Path) -> FileSaveDurability {
    match directory_sync {
        Ok(()) => FileSaveDurability::Durable,
        Err(error) => {
            tracing::warn!(%error, path = %target.display(), "file saved but parent directory sync failed");
            FileSaveDurability::Uncertain
        }
    }
}

fn preserve_owner(path: &Path, uid: u32, gid: u32) -> Result<(), ApiError> {
    let path =
        CString::new(path.as_os_str().as_bytes()).map_err(|_| invalid_path("path contains NUL"))?;
    // SAFETY: CString guarantees a terminating NUL and the values originate from metadata.
    let result = unsafe { libc::chown(path.as_ptr(), uid, gid) };
    if result == 0 {
        Ok(())
    } else {
        Err(metadata_preservation_error(
            io::Error::last_os_error(),
            "preserve file owner",
        ))
    }
}

/// 完整复制目标文件的扩展属性，包括 ACL 与安全标签。
async fn preserve_extended_attributes(source: &Path, target: &Path) -> Result<(), ApiError> {
    let source = source.to_path_buf();
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let names = xattr::list(&source)
            .map_err(|error| metadata_preservation_error(error, "list file metadata"))?;
        for name in names {
            let Some(value) = xattr::get(&source, &name)
                .map_err(|error| metadata_preservation_error(error, "read file metadata"))?
            else {
                continue;
            };
            xattr::set(&target, &name, &value)
                .map_err(|error| metadata_preservation_error(error, "write file metadata"))?;
        }
        Ok(())
    })
    .await
    .map_err(|_| ApiError::internal("file metadata task failed"))?
}

async fn sync_directory(path: &Path) -> Result<(), ApiError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::File::open(path)?.sync_all())
        .await
        .map_err(|_| ApiError::internal("directory sync task failed"))?
        .map_err(|error| map_io_error(error, "sync parent directory"))
}

fn ensure_text_size(content: &str) -> Result<(), ApiError> {
    if content.len() as u64 <= MAX_TEXT_BYTES {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        ErrorCode::FileContentTooLarge,
        "text content exceeds the 4 MiB editor limit",
    ))
}

fn ensure_regular_file(metadata: &std::fs::Metadata) -> Result<(), ApiError> {
    if metadata.is_file() {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCode::FileTypeUnsupported,
        "operation requires a regular file",
    ))
}

fn ensure_single_link(metadata: &std::fs::Metadata) -> Result<(), ApiError> {
    if metadata.nlink() == 1 {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCode::FileHardLinkUnsupported,
        "editing hard-linked files is not supported",
    ))
}

fn metadata_preservation_error(error: io::Error, operation: &'static str) -> ApiError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return ApiError::forbidden(
            ErrorCode::FilePermissionDenied,
            "target filesystem denied metadata preservation",
        );
    }
    tracing::warn!(%error, operation, "file metadata preservation failed");
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCode::FileMetadataPreservationFailed,
        "file metadata could not be preserved safely",
    )
}

fn document_from_content(path: &Path, content: &str, metadata: &std::fs::Metadata) -> FileDocument {
    FileDocument {
        path: path.to_string_lossy().into_owned(),
        content: content.to_string(),
        encoding: "utf8".to_string(),
        size_bytes: metadata.len(),
        revision: revision(metadata),
        modified_at: metadata.modified().ok().and_then(timestamp),
        loaded_at: now_timestamp(),
        capabilities: capabilities_from_metadata(FileEntryKind::File, metadata),
    }
}

fn summary_from_metadata(
    path: &Path,
    name: String,
    metadata: &std::fs::Metadata,
    roots: &[ManagementRoot],
) -> FileEntrySummary {
    let kind = kind(metadata);
    FileEntrySummary {
        name,
        path: path.to_string_lossy().into_owned(),
        kind,
        size_bytes: (kind == FileEntryKind::File).then_some(metadata.len()),
        modified_at: metadata.modified().ok().and_then(timestamp),
        created_at: metadata.created().ok().and_then(timestamp),
        revision: revision(metadata),
        management: management_for(path, roots),
        capabilities: capabilities_from_metadata(kind, metadata),
    }
}

fn kind(metadata: &std::fs::Metadata) -> FileEntryKind {
    let file_type = metadata.file_type();
    if file_type.is_file() {
        FileEntryKind::File
    } else if file_type.is_dir() {
        FileEntryKind::Directory
    } else if file_type.is_symlink() {
        FileEntryKind::Symlink
    } else {
        FileEntryKind::Other
    }
}

fn capabilities_for(kind: FileEntryKind) -> FileCapabilities {
    match kind {
        FileEntryKind::File => FileCapabilities {
            can_open: true,
            can_read: true,
            can_write: true,
            can_create_child: false,
            can_rename: true,
            can_copy: true,
            can_remove: true,
            can_upload: false,
            can_download: true,
        },
        FileEntryKind::Directory => FileCapabilities {
            can_open: true,
            can_read: true,
            can_write: false,
            can_create_child: true,
            can_rename: true,
            can_copy: true,
            can_remove: true,
            can_upload: true,
            can_download: false,
        },
        FileEntryKind::Symlink => FileCapabilities {
            can_open: true,
            can_read: true,
            can_write: true,
            can_create_child: false,
            can_rename: true,
            can_copy: true,
            can_remove: true,
            can_upload: false,
            can_download: false,
        },
        FileEntryKind::Other => FileCapabilities {
            can_rename: true,
            can_remove: true,
            ..FileCapabilities::default()
        },
    }
}

fn capabilities_from_metadata(
    kind: FileEntryKind,
    metadata: &std::fs::Metadata,
) -> FileCapabilities {
    let mut capabilities = capabilities_for(kind);
    if kind == FileEntryKind::File && metadata.nlink() != 1 {
        capabilities.can_write = false;
    }
    capabilities
}

async fn management_roots(pool: &DbPool) -> Result<Vec<ManagementRoot>, ApiError> {
    let mut roots = Vec::new();
    let rows =
        sqlx::query("SELECT compose_dir, management_kind, owner_name FROM docker_compose_projects")
            .fetch_all(pool)
            .await
            .map_err(|error| ApiError::database(error.to_string()))?;
    for row in rows {
        let management: String = row.try_get("management_kind").unwrap_or_default();
        let (kind, manage_via) = match management.as_str() {
            "suite" => (FileManagementKind::Suite, "suiteCenter"),
            "system" => (FileManagementKind::System, "system"),
            _ => (FileManagementKind::Compose, "dockerProjects"),
        };
        roots.push(ManagementRoot {
            path: PathBuf::from(row.try_get::<String, _>("compose_dir").unwrap_or_default()),
            kind,
            owner_name: row.try_get("owner_name").ok().flatten(),
            manage_via,
        });
    }
    roots.push(ManagementRoot {
        path: config::data_dir(),
        kind: FileManagementKind::System,
        owner_name: Some("Veydeck".to_string()),
        manage_via: "system",
    });
    if let Some(parent) = config::config_path().parent() {
        roots.push(ManagementRoot {
            path: parent.to_path_buf(),
            kind: FileManagementKind::System,
            owner_name: Some("Veydeck".to_string()),
            manage_via: "system",
        });
    }
    roots.sort_by(|left, right| {
        right
            .path
            .components()
            .count()
            .cmp(&left.path.components().count())
    });
    Ok(roots)
}

fn management_for(path: &Path, roots: &[ManagementRoot]) -> FileManagement {
    if let Some(root) = roots.iter().find(|root| path.starts_with(&root.path)) {
        return FileManagement {
            kind: root.kind,
            owner_name: root.owner_name.clone(),
            manage_via: Some(root.manage_via.to_string()),
        };
    }
    FileManagement {
        kind: FileManagementKind::Custom,
        owner_name: None,
        manage_via: Some("fileManager".to_string()),
    }
}

fn compare_entries(
    left: &FileEntrySummary,
    right: &FileEntrySummary,
    options: &FileListOptions,
) -> Ordering {
    let directory_order = matches!(right.kind, FileEntryKind::Directory)
        .cmp(&matches!(left.kind, FileEntryKind::Directory));
    if directory_order != Ordering::Equal {
        return directory_order;
    }
    let value_order = match options.sort_by {
        FileSortBy::Name => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        FileSortBy::ModifiedAt => compare_optional(&left.modified_at, &right.modified_at),
        FileSortBy::SizeBytes => compare_optional(&left.size_bytes, &right.size_bytes),
    };
    let value_order = if options.sort_order == FileSortOrder::Desc {
        value_order.reverse()
    } else {
        value_order
    };
    value_order.then_with(|| left.path.cmp(&right.path))
}

fn compare_optional<T: Ord>(left: &Option<T>, right: &Option<T>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

pub fn revision(metadata: &std::fs::Metadata) -> String {
    format!(
        "{:x}-{:x}-{:x}-{:x}-{:x}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec()
    )
}

fn timestamp(value: SystemTime) -> Option<String> {
    let value: DateTime<Utc> = value.into();
    Some(value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn invalid_path(message: &'static str) -> ApiError {
    ApiError::bad_request(ErrorCode::FileInvalidPath, message)
}

pub fn map_io_error(error: io::Error, operation: &'static str) -> ApiError {
    if error.raw_os_error() == Some(libc::ELOOP) {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::FileSymlinkLoop,
            "symbolic link resolution loop",
        );
    }
    match error.kind() {
        io::ErrorKind::NotFound => {
            ApiError::not_found(ErrorCode::FileNotFound, "file or directory does not exist")
        }
        io::ErrorKind::PermissionDenied => ApiError::forbidden(
            ErrorCode::FilePermissionDenied,
            "permission denied by the target filesystem",
        ),
        io::ErrorKind::AlreadyExists => ApiError::conflict(
            ErrorCode::FileAlreadyExists,
            "target file or directory already exists",
        ),
        _ if matches!(error.raw_os_error(), Some(libc::ENOSPC | libc::EDQUOT)) => ApiError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            ErrorCode::FileStorageExhausted,
            "target filesystem has insufficient storage",
        ),
        _ => {
            tracing::error!(%error, operation, "file operation failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorCode::FileOperationFailed,
                "file operation failed",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        async fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("veydeck-files-{label}-{}", Uuid::now_v7()));
            tokio::fs::create_dir(&path).await.unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn normalizes_absolute_paths_without_parent_references() {
        assert_eq!(
            normalize_absolute_path("//tmp/./demo").unwrap(),
            PathBuf::from("/tmp/demo")
        );
        for invalid in ["", "relative", "/tmp/../etc"] {
            assert!(normalize_absolute_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn special_files_do_not_advertise_content_operations() {
        let capabilities = capabilities_for(FileEntryKind::Other);
        assert!(!capabilities.can_read);
        assert!(!capabilities.can_copy);
        assert!(!capabilities.can_download);
        assert!(capabilities.can_remove);
        assert!(!capabilities_for(FileEntryKind::Symlink).can_download);
    }

    #[test]
    fn management_classification_uses_the_most_specific_root_without_restricting_capabilities() {
        let roots = vec![
            ManagementRoot {
                path: PathBuf::from("/srv/compose/suite"),
                kind: FileManagementKind::Suite,
                owner_name: Some("scanner".to_string()),
                manage_via: "suiteCenter",
            },
            ManagementRoot {
                path: PathBuf::from("/srv/compose"),
                kind: FileManagementKind::Compose,
                owner_name: Some("project".to_string()),
                manage_via: "dockerProjects",
            },
            ManagementRoot {
                path: PathBuf::from("/opt/veydeck"),
                kind: FileManagementKind::System,
                owner_name: Some("Veydeck".to_string()),
                manage_via: "system",
            },
        ];
        assert_eq!(
            management_for(Path::new("/srv/compose/suite/config"), &roots).kind,
            FileManagementKind::Suite
        );
        assert_eq!(
            management_for(Path::new("/srv/compose/project.yml"), &roots).kind,
            FileManagementKind::Compose
        );
        assert_eq!(
            management_for(Path::new("/opt/veydeck/config.toml"), &roots).kind,
            FileManagementKind::System
        );
        assert_eq!(
            management_for(Path::new("/home/admin/file"), &roots).kind,
            FileManagementKind::Custom
        );
        assert!(capabilities_for(FileEntryKind::File).can_remove);
    }

    /// 构造无文件条目的快照，独立验证预算和时钟行为。
    fn empty_snapshot(id: &str, bytes: usize) -> DirectorySnapshot {
        DirectorySnapshot {
            id: id.to_string(),
            path: PathBuf::from("/"),
            sort_by: FileSortBy::Name,
            sort_order: FileSortOrder::Asc,
            show_hidden: false,
            entries: Vec::new(),
            counts: FileEntryCounts::default(),
            loaded_at: String::new(),
            bytes,
        }
    }
    #[test]
    fn snapshot_cache_expires_and_evicts_by_lru_and_memory_budget() {
        let mut cache = SnapshotCache::default();
        cache.insert(empty_snapshot("old", 1)).unwrap();
        cache.entries[0].1 = Instant::now() - SNAPSHOT_IDLE - Duration::from_secs(1);
        assert!(cache.get("old").is_err());
        for index in 0..SNAPSHOT_MAX_COUNT {
            cache.insert(empty_snapshot(&index.to_string(), 1)).unwrap();
        }
        cache.get("0").unwrap();
        cache.insert(empty_snapshot("new", 1)).unwrap();
        assert!(cache.get("0").is_ok());
        assert!(cache.get("1").is_err());
        cache
            .insert(empty_snapshot("large", SNAPSHOT_MAX_BYTES))
            .unwrap();
        assert_eq!(cache.entries.len(), 1);
        assert!(
            cache
                .insert(empty_snapshot("oversized", SNAPSHOT_MAX_BYTES + 1))
                .is_err()
        );
    }

    #[tokio::test]
    async fn list_uses_stable_server_pagination_and_real_counts() {
        let pool = crate::test_support::setup_test_db().await;
        let root = TestDirectory::new("list").await;
        tokio::fs::create_dir(root.0.join("directory"))
            .await
            .unwrap();
        tokio::fs::write(root.0.join("b.txt"), b"bb").await.unwrap();
        tokio::fs::write(root.0.join("a.txt"), b"a").await.unwrap();
        tokio::fs::write(root.0.join(".hidden"), b"hidden")
            .await
            .unwrap();

        let page = list(
            &pool,
            FileListOptions {
                path: root.0.clone(),
                page: 1,
                page_size: 2,
                sort_by: FileSortBy::Name,
                sort_order: FileSortOrder::Asc,
                show_hidden: false,
                snapshot_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.counts.directory_count, 1);
        assert_eq!(page.counts.file_count, 2);
        assert_eq!(page.entries[0].name, "directory");
        assert_eq!(page.entries[1].name, "a.txt");

        // 目录在翻页期间改变，后续页仍应读取原快照。
        tokio::fs::remove_file(root.0.join("b.txt")).await.unwrap();
        tokio::fs::write(root.0.join("0.txt"), b"new")
            .await
            .unwrap();
        let second = list(
            &pool,
            FileListOptions {
                path: root.0.clone(),
                page: 2,
                page_size: 2,
                sort_by: FileSortBy::Name,
                sort_order: FileSortOrder::Asc,
                show_hidden: false,
                snapshot_id: Some(page.snapshot_id.clone()),
            },
        )
        .await
        .unwrap();
        assert_eq!(second.entries[0].name, "b.txt");
    }

    #[tokio::test]
    async fn atomic_update_rejects_stale_revision_without_overwriting() {
        let pool = crate::test_support::setup_test_db().await;
        let root = TestDirectory::new("revision").await;
        let path = root.0.join("document.txt");
        tokio::fs::write(&path, b"first").await.unwrap();
        let stale_revision = revision(&tokio::fs::metadata(&path).await.unwrap());
        tokio::fs::write(&path, b"external-change").await.unwrap();

        let error = update_content(&pool, &path, "editor-change", &stale_revision)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::FileChanged);
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "external-change"
        );
        let temporary_count = std::fs::read_dir(&root.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".veydeck-write-")
            })
            .count();
        assert_eq!(temporary_count, 0);
    }

    #[tokio::test]
    async fn atomic_update_rejects_hard_linked_files() {
        let pool = crate::test_support::setup_test_db().await;
        let root = TestDirectory::new("hard-link").await;
        let path = root.0.join("document.txt");
        let linked_path = root.0.join("linked.txt");
        tokio::fs::write(&path, b"original").await.unwrap();
        tokio::fs::hard_link(&path, &linked_path).await.unwrap();
        let current_revision = revision(&tokio::fs::metadata(&path).await.unwrap());

        let error = update_content(&pool, &path, "replacement", &current_revision)
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::FileHardLinkUnsupported);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "original");
        assert_eq!(tokio::fs::metadata(&linked_path).await.unwrap().nlink(), 2);
        assert!(!read_content(&path).await.unwrap().capabilities.can_write);
    }

    #[tokio::test]
    async fn atomic_update_preserves_mode_and_extended_attributes() {
        let pool = crate::test_support::setup_test_db().await;
        let root = TestDirectory::new("metadata").await;
        let path = root.0.join("document.txt");
        tokio::fs::write(&path, b"original").await.unwrap();
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o6750))
            .await
            .unwrap();
        xattr::set(&path, "user.veydeck-test", b"preserved").unwrap();
        let metadata = tokio::fs::metadata(&path).await.unwrap();
        let current_revision = revision(&metadata);

        let result = update_content(&pool, &path, "replacement", &current_revision)
            .await
            .unwrap();

        let updated = tokio::fs::metadata(&path).await.unwrap();
        assert_eq!(updated.mode() & 0o7777, 0o6750);
        assert_eq!(updated.uid(), metadata.uid());
        assert_eq!(updated.gid(), metadata.gid());
        assert_eq!(
            xattr::get(&path, "user.veydeck-test").unwrap().unwrap(),
            b"preserved"
        );
        assert_eq!(result.document.content, "replacement");
    }

    #[tokio::test]
    async fn linked_directories_keep_logical_paths_and_resolve_relative_chains() {
        let pool = crate::test_support::setup_test_db().await;
        let root = TestDirectory::new("linked-directory").await;
        let actual = root.0.join("actual");
        tokio::fs::create_dir(&actual).await.unwrap();
        tokio::fs::write(actual.join("note.txt"), b"text")
            .await
            .unwrap();
        std::os::unix::fs::symlink("actual", root.0.join("alias")).unwrap();
        std::os::unix::fs::symlink("alias", root.0.join("chain")).unwrap();
        let logical = root.0.join("chain");
        let info = detail(&pool, &logical).await.unwrap();
        assert_eq!(info.summary.kind, FileEntryKind::Symlink);
        assert_eq!(info.symlink_target_kind, Some(FileEntryKind::Directory));
        assert!(info.symlink_target_capabilities.unwrap().can_create_child);
        assert_eq!(info.symlink_target.as_deref(), Some("alias"));
        let page = list(
            &pool,
            FileListOptions {
                path: logical.clone(),
                page: 1,
                page_size: 50,
                sort_by: FileSortBy::Name,
                sort_order: FileSortOrder::Asc,
                show_hidden: false,
                snapshot_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.path, logical.to_string_lossy());
        assert_eq!(
            page.entries[0].path,
            logical.join("note.txt").to_string_lossy()
        );
        std::os::unix::fs::symlink("chain/note.txt", root.0.join("file-link")).unwrap();
        let file_link = root.0.join("file-link");
        assert_eq!(
            detail(&pool, &file_link).await.unwrap().symlink_target_kind,
            Some(FileEntryKind::File)
        );
        let document = read_content(&file_link).await.unwrap();
        assert_eq!(document.path, file_link.to_string_lossy());
        assert_eq!(document.content, "text");
    }

    #[tokio::test]
    async fn broken_and_looping_links_keep_their_own_details_and_return_target_errors() {
        let pool = crate::test_support::setup_test_db().await;
        let root = TestDirectory::new("bad-links").await;
        std::os::unix::fs::symlink("missing", root.0.join("broken")).unwrap();
        std::os::unix::fs::symlink("second", root.0.join("first")).unwrap();
        std::os::unix::fs::symlink("first", root.0.join("second")).unwrap();
        let broken = detail(&pool, &root.0.join("broken")).await.unwrap();
        assert_eq!(broken.summary.kind, FileEntryKind::Symlink);
        assert_eq!(broken.symlink_error, Some(ErrorCode::FileNotFound));
        assert!(broken.summary.capabilities.can_remove);
        let looping = detail(&pool, &root.0.join("first")).await.unwrap();
        assert_eq!(looping.symlink_error, Some(ErrorCode::FileSymlinkLoop));
        assert_eq!(
            map_io_error(
                io::Error::from_raw_os_error(libc::EACCES),
                "resolve symbolic link"
            )
            .code,
            ErrorCode::FilePermissionDenied
        );
    }

    #[tokio::test]
    async fn text_read_enforces_utf8_and_four_mebibyte_limit() {
        let root = TestDirectory::new("text-boundaries").await;
        let path = root.0.join("document.txt");
        tokio::fs::write(&path, vec![b'a'; MAX_TEXT_BYTES as usize])
            .await
            .unwrap();
        assert_eq!(
            read_content(&path).await.unwrap().size_bytes,
            MAX_TEXT_BYTES
        );

        tokio::fs::write(&path, vec![b'a'; MAX_TEXT_BYTES as usize + 1])
            .await
            .unwrap();
        assert_eq!(
            read_content(&path).await.unwrap_err().code,
            ErrorCode::FileContentTooLarge
        );

        tokio::fs::write(&path, [0xff, 0xfe]).await.unwrap();
        let error = read_content(&path).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::FileTypeUnsupported);
        assert_eq!(error.status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn symlink_edit_updates_target_without_replacing_link() {
        let pool = crate::test_support::setup_test_db().await;
        let root = TestDirectory::new("symlink-edit").await;
        let target = root.0.join("target.txt");
        let link = root.0.join("link.txt");
        tokio::fs::write(&target, b"original").await.unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let document = read_content(&link).await.unwrap();

        let result = update_content(&pool, &link, "replacement", &document.revision)
            .await
            .unwrap();

        assert!(
            tokio::fs::symlink_metadata(&link)
                .await
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            tokio::fs::read_to_string(&target).await.unwrap(),
            "replacement"
        );
        assert_eq!(result.document.path, link.to_string_lossy());
    }

    #[test]
    fn post_commit_directory_sync_failure_is_a_warning() {
        let durability = save_durability(
            Err(ApiError::internal("injected directory sync failure")),
            Path::new("/tmp/document.txt"),
        );
        assert_eq!(durability, FileSaveDurability::Uncertain);
    }

    #[test]
    fn unsupported_metadata_copy_has_stable_error() {
        let error = metadata_preservation_error(
            io::Error::from_raw_os_error(libc::ENOTSUP),
            "injected metadata copy",
        );
        assert_eq!(error.code, ErrorCode::FileMetadataPreservationFailed);
        assert_eq!(error.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}
