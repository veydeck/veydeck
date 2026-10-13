//! Veydeck 管理共享契约。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 当前 Veydeck 监听配置。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "veydeck/")]
pub struct VeydeckNetworkConfig {
    pub host: String,
    pub port: u16,
    pub public_host: Option<String>,
}

/// 更新 Veydeck 监听配置后的返回载荷。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "veydeck/")]
pub struct VeydeckNetworkUpdateResult {
    pub host: String,
    pub port: u16,
    pub next_url: String,
}
