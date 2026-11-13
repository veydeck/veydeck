//! 子节点访问 Master 运行时能力的共享客户端。

use anyhow::{Context, anyhow};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use veydeck_api::response::ApiResponse;
use veydeck_contracts::runtime_docker::{
    RuntimeImageSource, RuntimeImageTask, RuntimeImageTaskCreateRequest, RuntimeImageTaskQuery,
    RuntimeImageTaskStatus,
};
use veydeck_security::client::tls_client_builder;

const CONTROLLER_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const CONTROLLER_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const IMAGE_ACQUISITION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const IMAGE_TASK_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// 当前有效的 Master 运行时会话。
#[derive(Clone, Debug)]
struct ControllerSession {
    veydeck_url: String,
    agent_id: String,
    session_id: String,
}

/// 在 HTTP 处理任务与运行时监督器之间共享的 Master 客户端状态。
#[derive(Clone, Default)]
pub struct ControllerRuntime {
    session: Arc<RwLock<Option<ControllerSession>>>,
    suite_reports: Arc<RwLock<std::collections::HashMap<String, (String, std::time::Instant)>>>,
}

impl ControllerRuntime {
    /// 创建尚未建立会话的运行时客户端。
    pub fn new() -> Self {
        Self::default()
    }

    /// 发布新建立的活动会话。
    pub async fn set_session(&self, veydeck_url: &str, agent_id: &str, session_id: &str) {
        self.suite_reports.write().await.clear();
        *self.session.write().await = Some(ControllerSession {
            veydeck_url: veydeck_url.to_string(),
            agent_id: agent_id.to_string(),
            session_id: session_id.to_string(),
        });
    }

    /// 清除已失效的活动会话。
    pub async fn clear_session(&self) {
        *self.session.write().await = None;
    }

    /// 回报持久化意图的执行结果；变化立即回报，相同结果每 30 秒校准一次，离线不影响本地恢复。
    pub async fn report_suite_state(
        &self,
        instance: &str,
        project: &str,
        enabled: bool,
        error: Option<String>,
    ) -> anyhow::Result<()> {
        let Some(session) = self.session.read().await.clone() else {
            return Ok(());
        };
        let signature = serde_json::to_string(&(session.session_id.clone(), enabled, &error))?;
        if self
            .suite_reports
            .read()
            .await
            .get(project)
            .is_some_and(|(previous, sent)| {
                previous == &signature && sent.elapsed() < Duration::from_secs(30)
            })
        {
            return Ok(());
        }
        let response = tls_client_builder()?
            .connect_timeout(CONTROLLER_CONNECT_TIMEOUT)
            .timeout(CONTROLLER_REQUEST_TIMEOUT)
            .build()?
            .post(format!(
                "{}/api/v1/runtime/suites/state/report",
                session.veydeck_url.trim_end_matches('/')
            ))
            .json(&veydeck_contracts::suite_lifecycle::SuiteStateReport {
                agent_id: session.agent_id,
                session_id: session.session_id,
                instance_id: instance.to_string(),
                compose_project_name: project.to_string(),
                desired_enabled: enabled,
                error,
            })
            .send()
            .await?
            .error_for_status()?;
        let response = response.json::<ApiResponse<serde_json::Value>>().await?;
        if !response.success {
            return Err(anyhow!(response.message));
        }
        self.suite_reports
            .write()
            .await
            .insert(project.to_string(), (signature, std::time::Instant::now()));
        Ok(())
    }

    /// 通过 Master 为当前子节点准备镜像，并持续回传任务快照。
    pub async fn acquire_image<F, Fut>(
        &self,
        image_ref: &str,
        cancellation: &CancellationToken,
        mut on_progress: F,
    ) -> anyhow::Result<RuntimeImageSource>
    where
        F: FnMut(RuntimeImageTask) -> Fut,
        Fut: Future<Output = ()>,
    {
        let session = self
            .session
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("controller runtime session is unavailable"))?;
        let client = tls_client_builder()
            .context("failed to build controller TLS client")?
            .connect_timeout(CONTROLLER_CONNECT_TIMEOUT)
            .timeout(CONTROLLER_REQUEST_TIMEOUT)
            .build()
            .context("failed to build controller TLS client")?;
        let base_url = session.veydeck_url.trim_end_matches('/');
        let create_request = client
            .post(format!("{base_url}/api/v1/runtime/docker/image-tasks"))
            .json(&RuntimeImageTaskCreateRequest {
                agent_id: session.agent_id.clone(),
                session_id: session.session_id.clone(),
                image_ref: image_ref.to_string(),
            })
            .send();
        let response = tokio::select! {
            _ = cancellation.cancelled() => {
                return Err(anyhow!("image acquisition cancelled"));
            }
            result = create_request => result?,
        }
        .error_for_status()?
        .json::<ApiResponse<RuntimeImageTask>>()
        .await?;
        if !response.success {
            return Err(anyhow!(response.message));
        }
        let mut task = response
            .data
            .ok_or_else(|| anyhow!("controller returned no image task"))?;
        let query = RuntimeImageTaskQuery {
            agent_id: session.agent_id,
            session_id: session.session_id,
        };
        let deadline = tokio::time::Instant::now() + IMAGE_ACQUISITION_TIMEOUT;

        loop {
            on_progress(task.clone()).await;
            match task.status {
                RuntimeImageTaskStatus::Success => {
                    return task
                        .source
                        .ok_or_else(|| anyhow!("completed image task has no source"));
                }
                RuntimeImageTaskStatus::Failed => return Err(anyhow!(task.status_text)),
                RuntimeImageTaskStatus::Cancelled => {
                    return Err(anyhow!("controller image task was cancelled"));
                }
                RuntimeImageTaskStatus::Pending | RuntimeImageTaskStatus::Running => {}
            }
            tokio::select! {
                _ = cancellation.cancelled() => {
                    cancel_image_task(&client, base_url, &task.task_id, &query).await;
                    return Err(anyhow!("image acquisition cancelled"));
                }
                _ = tokio::time::sleep_until(deadline) => {
                    cancel_image_task(&client, base_url, &task.task_id, &query).await;
                    return Err(anyhow!("controller image acquisition timed out"));
                }
                _ = tokio::time::sleep(IMAGE_TASK_POLL_INTERVAL) => {}
            }
            let progress_request = client
                .get(format!(
                    "{base_url}/api/v1/runtime/docker/image-tasks/{}",
                    task.task_id
                ))
                .query(&query)
                .send();
            let response = tokio::select! {
                _ = cancellation.cancelled() => {
                    cancel_image_task(&client, base_url, &task.task_id, &query).await;
                    return Err(anyhow!("image acquisition cancelled"));
                }
                _ = tokio::time::sleep_until(deadline) => {
                    cancel_image_task(&client, base_url, &task.task_id, &query).await;
                    return Err(anyhow!("controller image acquisition timed out"));
                }
                result = progress_request => result?,
            }
            .error_for_status()?
            .json::<ApiResponse<RuntimeImageTask>>()
            .await?;
            if !response.success {
                return Err(anyhow!(response.message));
            }
            task = response
                .data
                .ok_or_else(|| anyhow!("controller returned no image task progress"))?;
        }
    }
}

/// 尽力取消 Master 上的镜像获取任务，失败不覆盖原始终止原因。
async fn cancel_image_task(
    client: &reqwest::Client,
    base_url: &str,
    task_id: &str,
    query: &RuntimeImageTaskQuery,
) {
    let _ = client
        .delete(format!(
            "{base_url}/api/v1/runtime/docker/image-tasks/{task_id}"
        ))
        .query(query)
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn image_acquisition_requires_an_active_runtime_session() {
        let runtime = ControllerRuntime::new();
        let cancellation = CancellationToken::new();
        let result = runtime
            .acquire_image("nginx:latest", &cancellation, |_| async {})
            .await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("runtime session is unavailable")
        );
    }
}
