//! 系统监控领域契约：定义分组趋势与设置 DTO。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 系统监控资源归属。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SystemMonitoringOwnership {
    System,
}

/// 历史趋势整体质量状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SystemMonitoringSeriesStatus {
    Complete,
    Partial,
    Stale,
    Empty,
}

/// 历史采集器的生命周期状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SystemMonitoringCollectionState {
    Initializing,
    Running,
    Degraded,
    Stopped,
}

/// 单个采集来源的可用状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SystemMonitoringSourceState {
    Available,
    Unavailable,
}

/// 系统监控管理能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitoringCapabilities {
    pub can_manage_collection: bool,
    pub can_clear_history: bool,
}

/// 单个采集来源的质量摘要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitoringSourceStatus {
    pub source: String,
    #[ts(inline)]
    pub state: SystemMonitoringSourceState,
}

/// 系统监控指标值；`None` 明确表示缺失或不可用。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitoringMetrics {
    pub cpu_percent: Option<f64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub memory_percent: Option<f64>,
    pub swap_percent: Option<f64>,
    pub load_average_1m: Option<f64>,
    pub load_average_5m: Option<f64>,
    pub load_average_15m: Option<f64>,
    pub disk_read_bytes_per_second: Option<f64>,
    pub disk_write_bytes_per_second: Option<f64>,
    pub network_receive_bytes_per_second: Option<f64>,
    pub network_transmit_bytes_per_second: Option<f64>,
}

/// 历史趋势中的一个时间点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitoringSeriesPoint<M> {
    pub sampled_at: String,
    pub coverage_percent: f64,
    #[ts(inline)]
    pub metrics: M,
}

/// 历史趋势指标分组。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SystemMonitoringGroup {
    Load,
    Cpu,
    Memory,
    DiskIo,
    Network,
}

impl SystemMonitoringGroup {
    /// 返回与序列化协议一致的查询参数值。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Load => "load",
            Self::Cpu => "cpu",
            Self::Memory => "memory",
            Self::DiskIo => "diskIo",
            Self::Network => "network",
        }
    }
}

/// 平均负载分组的历史指标；缺失值保留为 null。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadMonitoringMetrics {
    pub load_average_1m: Option<f64>,
    pub load_average_5m: Option<f64>,
    pub load_average_15m: Option<f64>,
}

/// CPU 分组的历史指标；缺失值保留为 null。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CpuMonitoringMetrics {
    pub cpu_percent: Option<f64>,
}

/// 内存分组的历史指标；缺失值保留为 null。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryMonitoringMetrics {
    pub memory_percent: Option<f64>,
    pub swap_percent: Option<f64>,
}

/// 磁盘 I/O 分组的历史指标；缺失值保留为 null。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskIoMonitoringMetrics {
    pub disk_read_bytes_per_second: Option<f64>,
    pub disk_write_bytes_per_second: Option<f64>,
}

/// 网络分组的历史指标；缺失值保留为 null。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkMonitoringMetrics {
    pub network_receive_bytes_per_second: Option<f64>,
    pub network_transmit_bytes_per_second: Option<f64>,
}

/// 分组标签与点位绑定，保证网关往返时不丢失或混入指标。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "group", rename_all = "camelCase")]
pub enum SystemMonitoringSeriesData {
    Load {
        #[ts(inline)]
        points: Vec<SystemMonitoringSeriesPoint<LoadMonitoringMetrics>>,
    },
    Cpu {
        #[ts(inline)]
        points: Vec<SystemMonitoringSeriesPoint<CpuMonitoringMetrics>>,
    },
    Memory {
        #[ts(inline)]
        points: Vec<SystemMonitoringSeriesPoint<MemoryMonitoringMetrics>>,
    },
    DiskIo {
        #[ts(inline)]
        points: Vec<SystemMonitoringSeriesPoint<DiskIoMonitoringMetrics>>,
    },
    Network {
        #[ts(inline)]
        points: Vec<SystemMonitoringSeriesPoint<NetworkMonitoringMetrics>>,
    },
}

/// 实时 CPU 指标；所有百分比使用同一采样间隔与总时间。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentCpuMetrics {
    pub cpu_percent: Option<f64>,
    pub user_percent: Option<f64>,
    pub system_percent: Option<f64>,
    pub io_wait_percent: Option<f64>,
}

/// 实时物理内存与 Swap 指标；可用估计与缓冲、缓存重叠，不属于构成条分区。
/// Swap 总量为零表示未配置，利用率不可用；已用由总量减空闲得到。
/// 构成条使用其他已用、缓冲、缓存与空闲；其他已用由总计扣除其余三项得到。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentMemoryMetrics {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub usage_percent: Option<f64>,
    pub buffers_bytes: Option<u64>,
    pub cached_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub other_used_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
    pub swap_free_bytes: Option<u64>,
    pub swap_percent: Option<f64>,
}

/// 实时采样状态，不表达历史覆盖率。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SystemMonitoringCurrentStatus {
    Fresh,
    Stale,
    Unavailable,
}

/// 当前分组的严格指标类型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "group", rename_all = "camelCase")]
pub enum SystemMonitoringCurrentData {
    Load {
        #[ts(inline)]
        metrics: LoadMonitoringMetrics,
    },
    Cpu {
        #[ts(inline)]
        metrics: CurrentCpuMetrics,
    },
    Memory {
        #[ts(inline)]
        metrics: CurrentMemoryMetrics,
    },
    DiskIo {
        #[ts(inline)]
        metrics: DiskIoMonitoringMetrics,
    },
    Network {
        #[ts(inline)]
        metrics: NetworkMonitoringMetrics,
    },
}

/// 当前分组的实时资源快照；样本年龄为 Agent 单调计时经过的毫秒数，未采样时为空。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "monitoring/")]
pub struct SystemMonitoringCurrent {
    pub sampled_at: Option<String>,
    pub sample_age_ms: Option<u64>,
    #[ts(inline)]
    pub status: SystemMonitoringCurrentStatus,
    #[serde(flatten)]
    pub data: SystemMonitoringCurrentData,
}

/// 实时查询必须明确选择一个指标分组。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemMonitoringCurrentQuery {
    pub group: SystemMonitoringGroup,
}

/// 历史趋势游标分页信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitoringPageInfo {
    pub limit: u16,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

/// 系统监控历史趋势页。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "monitoring/")]
pub struct SystemMonitoringSeriesPage {
    pub range: String,
    pub from: String,
    pub to: String,
    pub resolution_seconds: u32,
    #[ts(inline)]
    pub series_status: SystemMonitoringSeriesStatus,
    pub expected_point_count: u32,
    pub actual_point_count: u32,
    pub coverage_percent: f64,
    #[serde(flatten)]
    pub data: SystemMonitoringSeriesData,
    #[ts(inline)]
    pub collection_state: SystemMonitoringCollectionState,
    #[ts(inline)]
    pub page_info: SystemMonitoringPageInfo,
}

/// 系统监控设置与存储摘要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "monitoring/")]
pub struct SystemMonitoringSettings {
    #[ts(inline)]
    pub ownership: SystemMonitoringOwnership,
    pub history_collection_enabled: bool,
    pub history_sample_interval_seconds: u32,
    pub retention_days: u8,
    pub stored_sample_count: u64,
    pub oldest_sampled_at: Option<String>,
    pub newest_sampled_at: Option<String>,
    #[ts(inline)]
    pub capabilities: SystemMonitoringCapabilities,
}
