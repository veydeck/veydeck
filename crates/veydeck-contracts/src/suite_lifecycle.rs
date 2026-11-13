//! 依赖套件的节点执行结果契约。

use serde::{Deserialize, Serialize};

/// 节点执行结果回报；运行意图和执行错误明确分离。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteStateReport {
    pub agent_id: String,
    pub session_id: String,
    pub instance_id: String,
    pub compose_project_name: String,
    pub desired_enabled: bool,
    pub error: Option<String>,
}
