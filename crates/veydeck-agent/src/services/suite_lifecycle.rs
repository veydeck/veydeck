//! 依赖套件的互斥、socket 校验与可取消恢复循环。

use crate::state::AppState;
use crate::types::{ApiError, ApiResult};
use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{OwnedMutexGuard, watch};

static PROJECT_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 与卸载工具互斥；卸载期间立即拒绝新套件变更。
pub fn change_guard() -> ApiResult<File> {
    veydeck_contracts::agent_lifecycle::acquire(
        &veydeck_contracts::types::agent_lifecycle_lock_path(),
        false,
    )
    .map_err(|error| ApiError::Internal(error.to_string()))
}

/// 按项目串行执行启停、迁移与后台恢复。
pub async fn project_guard(project: &str) -> OwnedMutexGuard<()> {
    let lock = PROJECT_LOCKS
        .lock()
        .unwrap()
        .entry(project.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    lock.lock_owned().await
}

/// 只清理连接已被拒绝的 socket，拒绝符号链接及其他文件类型。
pub async fn prepare_socket(path: &Path) -> std::io::Result<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_socket() {
        return Err(std::io::Error::other(format!(
            "expected Unix socket, found {:?}; refusing to remove {}",
            metadata.file_type(),
            path.display()
        )));
    }
    match tokio::net::UnixStream::connect(path).await {
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "another Agent is listening",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            tokio::fs::remove_file(path).await
        }
        Err(error) => Err(error),
    }
}

/// 健康接口已能响应后再恢复套件；关闭时等待正在执行的操作退出。
pub fn spawn(state: Arc<AppState>, mut stop: watch::Receiver<bool>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut retries = HashMap::new();
        let mut last_error = String::new();
        loop {
            if *stop.borrow() {
                return;
            }
            let cycle = async {
                if !listener_ready(&state).await? {
                    return Ok(());
                }
                crate::api::docker::suites::reconcile_projects(&state, &mut retries).await
            };
            let result: ApiResult<()> = tokio::select! {
                changed = stop.changed() => { let _ = changed; return; }
                result = cycle => result,
            };
            match result {
                Ok(()) => {
                    last_error.clear();
                }
                Err(error) => {
                    let message = error.to_string();
                    if message != last_error {
                        tracing::warn!(error = %message, "Suite reconciliation is waiting");
                        last_error = message;
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                _ = stop.changed() => return,
            }
        }
    })
}

/// 通过本机健康接口确认监听器已就绪，不依赖 Master 会话。
async fn listener_ready(state: &AppState) -> ApiResult<bool> {
    use crate::services::agent_runtime::{self, CommandTransport};
    let runtime = agent_runtime::load(&state.metadata_db)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    let client = match runtime.command_transport {
        CommandTransport::Uds => {
            reqwest::Client::builder().unix_socket(veydeck_contracts::types::agent_socket_path())
        }
        CommandTransport::Https => {
            // TLS 监听必须验证客户端证书，使用平台既有身份与 CA。
            let client = veydeck_security::client::mtls_client_builder("suite-readiness")
                .map_err(|error| ApiError::Internal(error.to_string()))?;
            return Ok(client
                .timeout(Duration::from_secs(2))
                .build()
                .map_err(|error| ApiError::Internal(error.to_string()))?
                .get(format!(
                    "https://127.0.0.1:{}/api/v1/agent/runtime/health",
                    runtime
                        .suite_command_base_url
                        .as_deref()
                        .unwrap_or("")
                        .rsplit(':')
                        .next()
                        .unwrap_or("7311")
                ))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success()));
        }
    };
    Ok(client
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .get("http://local/api/v1/agent/runtime/health")
        .send()
        .await
        .is_ok_and(|response| response.status().is_success()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 路径类型异常不能被当成失效 socket 删除。
    #[tokio::test]
    async fn socket_cleanup_preserves_other_types_and_active_listener() {
        let root = std::env::temp_dir().join(format!("veydeck-socket-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("agent.sock");
        std::fs::create_dir(&path).unwrap();
        assert!(prepare_socket(&path).await.is_err());
        assert!(path.is_dir());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "keep").unwrap();
        assert!(prepare_socket(&path).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.join("missing"), &path).unwrap();
        assert!(prepare_socket(&path).await.is_err());
        assert!(path.is_symlink());
        std::fs::remove_file(&path).unwrap();
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        assert!(prepare_socket(&path).await.is_err());
        drop(listener);
        prepare_socket(&path).await.unwrap();
        assert!(!path.exists());
        std::fs::remove_dir(root).unwrap();
    }
}
