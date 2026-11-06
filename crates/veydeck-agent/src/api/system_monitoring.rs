//! 系统监控 API：提供分组实时指标、历史趋势与采集设置。

use axum::{
    Json, Router,
    extract::{FromRequestParts, Query, State, rejection::JsonRejection},
    http::HeaderName,
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::{collections::BTreeMap, sync::Arc, time::Instant};
use veydeck_contracts::{
    api::ErrorCode,
    monitoring::{
        CpuMonitoringMetrics, DiskIoMonitoringMetrics, LoadMonitoringMetrics,
        MemoryMonitoringMetrics, NetworkMonitoringMetrics, SystemMonitoringCapabilities,
        SystemMonitoringCollectionState, SystemMonitoringCurrent, SystemMonitoringCurrentData,
        SystemMonitoringCurrentQuery, SystemMonitoringCurrentStatus, SystemMonitoringGroup,
        SystemMonitoringMetrics, SystemMonitoringOwnership, SystemMonitoringPageInfo,
        SystemMonitoringSeriesData, SystemMonitoringSeriesPage, SystemMonitoringSeriesPoint,
        SystemMonitoringSeriesStatus, SystemMonitoringSettings,
    },
};

use crate::{
    services::system_monitoring::{
        CurrentHostSnapshot, HISTORY_SAMPLE_INTERVAL_SECONDS, RawHostMetricSample,
        SystemMonitoringStorageSettings,
    },
    state::AppState,
    types::{ApiError, ApiResponse, ApiResult},
};

const ACTOR_KIND_HEADER: HeaderName = HeaderName::from_static("x-veydeck-actor-kind");
const ACTOR_NAME_HEADER: HeaderName = HeaderName::from_static("x-veydeck-actor-name");
const MAX_SERIES_LIMIT: u16 = 500;

/// 由 Master 注入且通过内部链路传递的变更操作上下文。
struct TrustedOperationContext;

impl<S> FromRequestParts<S> for TrustedOperationContext
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let actor_kind = parts
            .headers
            .get(&ACTOR_KIND_HEADER)
            .and_then(|value| value.to_str().ok());
        let actor_name = parts
            .headers
            .get(&ACTOR_NAME_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if matches!(actor_kind, Some("user" | "system")) && actor_name.is_some() {
            return Ok(Self);
        }
        Err(ApiError::forbidden(
            ErrorCode::AuthForbidden,
            "trusted operation context is required",
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemMonitoringSettingsUpdate {
    pub history_collection_enabled: bool,
    pub retention_days: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemMonitoringSeriesQuery {
    pub group: SystemMonitoringGroup,
    #[serde(default = "default_range")]
    pub range: String,
    #[serde(default = "default_sort")]
    pub sort: String,
    #[serde(default = "default_limit")]
    pub limit: u16,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearHistoryResult {
    cleared_sample_count: u64,
}

#[derive(Debug, Clone, FromRow)]
struct StoredSample {
    sampled_at: i64,
    cpu_percent: Option<f64>,
    memory_used_bytes: Option<i64>,
    memory_total_bytes: Option<i64>,
    memory_percent: Option<f64>,
    swap_percent: Option<f64>,
    load_average_1m: Option<f64>,
    load_average_5m: Option<f64>,
    load_average_15m: Option<f64>,
    disk_read_bytes: Option<i64>,
    disk_write_bytes: Option<i64>,
    network_receive_bytes: Option<i64>,
    network_transmit_bytes: Option<i64>,
}

impl StoredSample {
    fn to_raw(&self) -> RawHostMetricSample {
        RawHostMetricSample {
            sampled_at: self.sampled_at,
            cpu_percent: self.cpu_percent,
            memory_used_bytes: as_u64(self.memory_used_bytes),
            memory_total_bytes: as_u64(self.memory_total_bytes),
            memory_percent: self.memory_percent,
            swap_percent: self.swap_percent,
            load_average_1m: self.load_average_1m,
            load_average_5m: self.load_average_5m,
            load_average_15m: self.load_average_15m,
            disk_read_bytes: as_u64(self.disk_read_bytes),
            disk_write_bytes: as_u64(self.disk_write_bytes),
            network_receive_bytes: as_u64(self.network_receive_bytes),
            network_transmit_bytes: as_u64(self.network_transmit_bytes),
            source_statuses: Vec::new(),
        }
    }
}

/// 构建 Agent 内部系统监控路由。
pub fn system_monitoring_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/current", get(current))
        .route("/series", get(series))
        .route("/settings", get(settings).put(update_settings))
        .route("/history", delete(clear_history))
}

/// 读取唯一后台采样器的缓存，不触发新采样或历史查询。
async fn current(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SystemMonitoringCurrentQuery>,
) -> ApiResult<Response> {
    let cached = state.system_monitoring.current.read().await;
    let data = build_current(cached.as_ref(), query.group, Instant::now())?;
    Ok(
        ApiResponse::success_with_raw("System monitoring current loaded", Some(data))
            .into_response(),
    )
}

/// 投影当前分组，并独立判断采样是否过期或尚不可用。
fn build_current(
    snapshot: Option<&CurrentHostSnapshot>,
    group: SystemMonitoringGroup,
    now: Instant,
) -> ApiResult<SystemMonitoringCurrent> {
    let empty = SystemMonitoringMetrics::default();
    let metrics = snapshot.map(|snapshot| &snapshot.metrics).unwrap_or(&empty);
    let (data, available) = match group {
        SystemMonitoringGroup::Load => (
            SystemMonitoringCurrentData::Load {
                metrics: LoadMonitoringMetrics {
                    load_average_1m: metrics.load_average_1m,
                    load_average_5m: metrics.load_average_5m,
                    load_average_15m: metrics.load_average_15m,
                },
            },
            metrics.load_average_1m.is_some()
                || metrics.load_average_5m.is_some()
                || metrics.load_average_15m.is_some(),
        ),
        SystemMonitoringGroup::Cpu => (
            SystemMonitoringCurrentData::Cpu {
                metrics: snapshot.map(|s| s.cpu.clone()).unwrap_or_default(),
            },
            snapshot.is_some_and(|s| s.cpu.cpu_percent.is_some()),
        ),
        SystemMonitoringGroup::Memory => (
            SystemMonitoringCurrentData::Memory {
                metrics: snapshot.map(|s| s.memory.clone()).unwrap_or_default(),
            },
            snapshot.is_some_and(|s| s.memory.total_bytes.is_some()),
        ),
        SystemMonitoringGroup::DiskIo => (
            SystemMonitoringCurrentData::DiskIo {
                metrics: DiskIoMonitoringMetrics {
                    disk_read_bytes_per_second: metrics.disk_read_bytes_per_second,
                    disk_write_bytes_per_second: metrics.disk_write_bytes_per_second,
                },
            },
            metrics.disk_read_bytes_per_second.is_some()
                || metrics.disk_write_bytes_per_second.is_some(),
        ),
        SystemMonitoringGroup::Network => (
            SystemMonitoringCurrentData::Network {
                metrics: NetworkMonitoringMetrics {
                    network_receive_bytes_per_second: metrics.network_receive_bytes_per_second,
                    network_transmit_bytes_per_second: metrics.network_transmit_bytes_per_second,
                },
            },
            metrics.network_receive_bytes_per_second.is_some()
                || metrics.network_transmit_bytes_per_second.is_some(),
        ),
    };
    let sample_age_ms = snapshot.map(|snapshot| {
        u64::try_from(
            now.saturating_duration_since(snapshot.sampled_since)
                .as_millis(),
        )
        .unwrap_or(u64::MAX)
    });
    let status = if sample_age_ms.is_some_and(|age| age > 10_000) {
        SystemMonitoringCurrentStatus::Stale
    } else if available {
        SystemMonitoringCurrentStatus::Fresh
    } else {
        SystemMonitoringCurrentStatus::Unavailable
    };
    Ok(SystemMonitoringCurrent {
        sample_age_ms,
        sampled_at: snapshot
            .map(|snapshot| format_epoch(snapshot.sampled_at))
            .transpose()?,
        status,
        data,
    })
}

/// 返回固定分辨率并显式包含缺失桶的历史趋势。
async fn series(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SystemMonitoringSeriesQuery>,
) -> ApiResult<Response> {
    let range = parse_range(&query.range)?;
    if query.limit == 0 || query.limit > MAX_SERIES_LIMIT {
        return Err(invalid_range("limit must be between 1 and 500"));
    }
    if query.sort != "asc" && query.sort != "desc" {
        return Err(invalid_range("sort must be asc or desc"));
    }
    let settings = *state.system_monitoring.settings.read().await;
    if range.duration_seconds > i64::from(settings.retention_days) * 86_400 {
        return Err(invalid_range("range exceeds configured retention"));
    }
    let offset = query
        .cursor
        .as_deref()
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| invalid_range("cursor is invalid"))?
        .unwrap_or_default();

    let to = Utc::now().timestamp();
    let from = to - range.duration_seconds;
    let rows = load_series_rows(&state, from, to).await?;
    let mut points = build_series_points(&rows, from, to, range.resolution_seconds, query.group)?;
    let expected_point_count = points.len() as u32;
    let actual_point_count = points
        .iter()
        .filter(|point| point.coverage_percent > 0.0)
        .count() as u32;
    let coverage_percent = if expected_point_count == 0 {
        0.0
    } else {
        points
            .iter()
            .map(|point| point.coverage_percent)
            .sum::<f64>()
            / f64::from(expected_point_count)
    };
    if query.sort == "desc" {
        points.reverse();
    }
    if offset > points.len() {
        return Err(invalid_range("cursor is outside the result set"));
    }
    let end = (offset + usize::from(query.limit)).min(points.len());
    let has_more = end < points.len();
    let page_points = points[offset..end].to_vec();
    let collection_state = *state.system_monitoring.collection_state.read().await;
    let newest_sampled_at = rows.iter().enumerate().rev().find_map(|(index, row)| {
        let previous = index.checked_sub(1).map(|index| rows[index].to_raw());
        let metrics = row.to_raw().metrics(previous.as_ref());
        (row.sampled_at >= from && group_coverage(query.group, &metrics) > 0.0)
            .then_some(row.sampled_at)
    });
    let series_status = if actual_point_count == 0 {
        SystemMonitoringSeriesStatus::Empty
    } else if collection_state == SystemMonitoringCollectionState::Stopped
        || newest_sampled_at.is_none_or(|sampled_at| to - sampled_at > 120)
    {
        SystemMonitoringSeriesStatus::Stale
    } else if coverage_percent < 100.0 {
        SystemMonitoringSeriesStatus::Partial
    } else {
        SystemMonitoringSeriesStatus::Complete
    };

    let response = SystemMonitoringSeriesPage {
        range: query.range,
        from: format_epoch(from)?,
        to: format_epoch(to)?,
        resolution_seconds: range.resolution_seconds as u32,
        series_status,
        expected_point_count,
        actual_point_count,
        coverage_percent,
        data: project_series(query.group, page_points),
        collection_state,
        page_info: SystemMonitoringPageInfo {
            limit: query.limit,
            has_more,
            next_cursor: has_more.then(|| end.to_string()),
        },
    };
    Ok(
        ApiResponse::success_with_raw("System monitoring series loaded", Some(response))
            .into_response(),
    )
}

/// 返回采集设置和当前存储摘要。
async fn settings(State(state): State<Arc<AppState>>) -> ApiResult<Response> {
    let response = load_settings_response(&state).await?;
    Ok(
        ApiResponse::success_with_raw("System monitoring settings loaded", Some(response))
            .into_response(),
    )
}

/// 原子更新采集设置，并在缩短保留期时同步清理过期样本。
async fn update_settings(
    State(state): State<Arc<AppState>>,
    _context: TrustedOperationContext,
    payload: Result<Json<SystemMonitoringSettingsUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(payload) = payload.map_err(|_| {
        ApiError::bad_request(
            ErrorCode::SystemMonitoringInvalidSettings,
            "system monitoring settings payload is invalid",
        )
    })?;
    validate_retention(payload.retention_days)?;
    let _maintenance = state
        .system_monitoring
        .maintenance
        .try_lock()
        .map_err(|_| history_busy())?;
    let now = Utc::now().timestamp();
    let cutoff = now - i64::from(payload.retention_days) * 86_400;
    let mut transaction = state.metadata_db.begin().await.map_err(database_error)?;
    sqlx::query(
        r#"
        UPDATE system_monitoring_settings
        SET history_collection_enabled = ?, retention_days = ?, updated_at = ?
        WHERE singleton_id = 1
        "#,
    )
    .bind(payload.history_collection_enabled)
    .bind(payload.retention_days)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query("DELETE FROM system_monitoring_samples WHERE sampled_at < ?")
        .bind(cutoff)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    *state.system_monitoring.settings.write().await = SystemMonitoringStorageSettings {
        history_collection_enabled: payload.history_collection_enabled,
        retention_days: payload.retention_days,
    };
    *state.system_monitoring.collection_state.write().await = if payload.history_collection_enabled
    {
        SystemMonitoringCollectionState::Initializing
    } else {
        SystemMonitoringCollectionState::Stopped
    };
    let response = load_settings_response(&state).await?;
    Ok(
        ApiResponse::success_with_raw("System monitoring settings updated", Some(response))
            .into_response(),
    )
}

/// 清空历史；重复维护请求返回稳定的 409。
async fn clear_history(
    State(state): State<Arc<AppState>>,
    _context: TrustedOperationContext,
) -> ApiResult<Response> {
    let _maintenance = state
        .system_monitoring
        .maintenance
        .try_lock()
        .map_err(|_| history_busy())?;
    let result = sqlx::query("DELETE FROM system_monitoring_samples")
        .execute(&state.metadata_db)
        .await
        .map_err(database_error)?;
    Ok(ApiResponse::success_with_raw(
        "System monitoring history cleared",
        Some(ClearHistoryResult {
            cleared_sample_count: result.rows_affected(),
        }),
    )
    .into_response())
}

async fn load_series_rows(state: &AppState, from: i64, to: i64) -> ApiResult<Vec<StoredSample>> {
    sqlx::query_as::<_, StoredSample>(
        r#"
        SELECT sampled_at, cpu_percent, memory_used_bytes, memory_total_bytes, memory_percent, swap_percent,
               load_average_1m, load_average_5m, load_average_15m,
               disk_read_bytes, disk_write_bytes,
               network_receive_bytes, network_transmit_bytes
        FROM system_monitoring_samples
        WHERE sampled_at >= ? AND sampled_at <= ?
        ORDER BY sampled_at ASC
        "#,
    )
    .bind(from - 150)
    .bind(to)
    .fetch_all(&state.metadata_db)
    .await
    .map_err(database_error)
}

fn build_series_points(
    rows: &[StoredSample],
    from: i64,
    to: i64,
    resolution_seconds: i64,
    group: SystemMonitoringGroup,
) -> ApiResult<Vec<SystemMonitoringSeriesPoint<SystemMonitoringMetrics>>> {
    let expected = ((to - from) / resolution_seconds).max(1) as usize;
    let mut buckets: BTreeMap<usize, Vec<(SystemMonitoringMetrics, f64)>> = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        if row.sampled_at < from {
            continue;
        }
        let bucket = ((row.sampled_at - from) / resolution_seconds) as usize;
        if bucket >= expected {
            continue;
        }
        let previous = index
            .checked_sub(1)
            .and_then(|previous_index| rows.get(previous_index))
            .map(StoredSample::to_raw);
        let raw = row.to_raw();
        let metrics = raw.metrics(previous.as_ref());
        let coverage = group_coverage(group, &metrics);
        buckets.entry(bucket).or_default().push((metrics, coverage));
    }

    (0..expected)
        .map(|index| {
            let sampled_at = from + index as i64 * resolution_seconds;
            let values = buckets.get(&index).map(Vec::as_slice).unwrap_or_default();
            Ok(SystemMonitoringSeriesPoint {
                sampled_at: format_epoch(sampled_at)?,
                coverage_percent: average(values.iter().map(|(_, coverage)| Some(*coverage)))
                    .unwrap_or(0.0),
                metrics: aggregate_metrics(values),
            })
        })
        .collect()
}

/// 仅以当前分组有效指标计算覆盖率。
fn group_coverage(group: SystemMonitoringGroup, metrics: &SystemMonitoringMetrics) -> f64 {
    let values: &[Option<f64>] = match group {
        SystemMonitoringGroup::Load => &[
            metrics.load_average_1m,
            metrics.load_average_5m,
            metrics.load_average_15m,
        ],
        SystemMonitoringGroup::Cpu => &[metrics.cpu_percent],
        SystemMonitoringGroup::Memory => &[metrics.memory_percent],
        SystemMonitoringGroup::DiskIo => &[
            metrics.disk_read_bytes_per_second,
            metrics.disk_write_bytes_per_second,
        ],
        SystemMonitoringGroup::Network => &[
            metrics.network_receive_bytes_per_second,
            metrics.network_transmit_bytes_per_second,
        ],
    };
    values.iter().filter(|value| value.is_some()).count() as f64 / values.len() as f64 * 100.0
}

/// 在 Agent 边界投影为严格分组类型，减少两段链路传输。
fn project_series(
    group: SystemMonitoringGroup,
    points: Vec<SystemMonitoringSeriesPoint<SystemMonitoringMetrics>>,
) -> SystemMonitoringSeriesData {
    match group {
        SystemMonitoringGroup::Load => SystemMonitoringSeriesData::Load {
            points: points
                .into_iter()
                .map(|point| SystemMonitoringSeriesPoint {
                    sampled_at: point.sampled_at,
                    coverage_percent: point.coverage_percent,
                    metrics: LoadMonitoringMetrics {
                        load_average_1m: point.metrics.load_average_1m,
                        load_average_5m: point.metrics.load_average_5m,
                        load_average_15m: point.metrics.load_average_15m,
                    },
                })
                .collect(),
        },
        SystemMonitoringGroup::Cpu => SystemMonitoringSeriesData::Cpu {
            points: points
                .into_iter()
                .map(|point| SystemMonitoringSeriesPoint {
                    sampled_at: point.sampled_at,
                    coverage_percent: point.coverage_percent,
                    metrics: CpuMonitoringMetrics {
                        cpu_percent: point.metrics.cpu_percent,
                    },
                })
                .collect(),
        },
        SystemMonitoringGroup::Memory => SystemMonitoringSeriesData::Memory {
            points: points
                .into_iter()
                .map(|point| SystemMonitoringSeriesPoint {
                    sampled_at: point.sampled_at,
                    coverage_percent: point.coverage_percent,
                    metrics: MemoryMonitoringMetrics {
                        memory_percent: point.metrics.memory_percent,
                        swap_percent: point.metrics.swap_percent,
                    },
                })
                .collect(),
        },
        SystemMonitoringGroup::DiskIo => SystemMonitoringSeriesData::DiskIo {
            points: points
                .into_iter()
                .map(|point| SystemMonitoringSeriesPoint {
                    sampled_at: point.sampled_at,
                    coverage_percent: point.coverage_percent,
                    metrics: DiskIoMonitoringMetrics {
                        disk_read_bytes_per_second: point.metrics.disk_read_bytes_per_second,
                        disk_write_bytes_per_second: point.metrics.disk_write_bytes_per_second,
                    },
                })
                .collect(),
        },
        SystemMonitoringGroup::Network => SystemMonitoringSeriesData::Network {
            points: points
                .into_iter()
                .map(|point| SystemMonitoringSeriesPoint {
                    sampled_at: point.sampled_at,
                    coverage_percent: point.coverage_percent,
                    metrics: NetworkMonitoringMetrics {
                        network_receive_bytes_per_second: point
                            .metrics
                            .network_receive_bytes_per_second,
                        network_transmit_bytes_per_second: point
                            .metrics
                            .network_transmit_bytes_per_second,
                    },
                })
                .collect(),
        },
    }
}

fn aggregate_metrics(values: &[(SystemMonitoringMetrics, f64)]) -> SystemMonitoringMetrics {
    let metric = |read: fn(&SystemMonitoringMetrics) -> Option<f64>| {
        average(values.iter().map(|(metrics, _)| read(metrics)))
    };
    let integer_metric = |read: fn(&SystemMonitoringMetrics) -> Option<u64>| {
        average(
            values
                .iter()
                .map(|(metrics, _)| read(metrics).map(|value| value as f64)),
        )
        .map(|value| value.round() as u64)
    };
    SystemMonitoringMetrics {
        cpu_percent: metric(|value| value.cpu_percent),
        memory_used_bytes: integer_metric(|value| value.memory_used_bytes),
        memory_total_bytes: integer_metric(|value| value.memory_total_bytes),
        memory_percent: metric(|value| value.memory_percent),
        swap_percent: metric(|value| value.swap_percent),
        load_average_1m: metric(|value| value.load_average_1m),
        load_average_5m: metric(|value| value.load_average_5m),
        load_average_15m: metric(|value| value.load_average_15m),
        disk_read_bytes_per_second: metric(|value| value.disk_read_bytes_per_second),
        disk_write_bytes_per_second: metric(|value| value.disk_write_bytes_per_second),
        network_receive_bytes_per_second: metric(|value| value.network_receive_bytes_per_second),
        network_transmit_bytes_per_second: metric(|value| value.network_transmit_bytes_per_second),
    }
}

fn average(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let (sum, count) = values
        .flatten()
        .fold((0.0, 0_u32), |(sum, count), value| (sum + value, count + 1));
    (count > 0).then(|| sum / f64::from(count))
}

async fn load_settings_response(state: &AppState) -> ApiResult<SystemMonitoringSettings> {
    let settings = *state.system_monitoring.settings.read().await;
    let summary = sqlx::query_as::<_, (i64, Option<i64>, Option<i64>)>(
        "SELECT COUNT(*), MIN(sampled_at), MAX(sampled_at) FROM system_monitoring_samples",
    )
    .fetch_one(&state.metadata_db)
    .await
    .map_err(database_error)?;
    Ok(SystemMonitoringSettings {
        ownership: SystemMonitoringOwnership::System,
        history_collection_enabled: settings.history_collection_enabled,
        history_sample_interval_seconds: HISTORY_SAMPLE_INTERVAL_SECONDS,
        retention_days: settings.retention_days,
        stored_sample_count: summary.0.max(0) as u64,
        oldest_sampled_at: summary.1.map(format_epoch).transpose()?,
        newest_sampled_at: summary.2.map(format_epoch).transpose()?,
        capabilities: capabilities(),
    })
}

#[derive(Clone, Copy)]
struct RangeDefinition {
    duration_seconds: i64,
    resolution_seconds: i64,
}

fn parse_range(value: &str) -> ApiResult<RangeDefinition> {
    let definition = match value {
        "1h" => RangeDefinition {
            duration_seconds: 3_600,
            resolution_seconds: 60,
        },
        "6h" => RangeDefinition {
            duration_seconds: 21_600,
            resolution_seconds: 60,
        },
        "24h" => RangeDefinition {
            duration_seconds: 86_400,
            resolution_seconds: 300,
        },
        "3d" => RangeDefinition {
            duration_seconds: 259_200,
            resolution_seconds: 900,
        },
        "7d" => RangeDefinition {
            duration_seconds: 604_800,
            resolution_seconds: 1_800,
        },
        _ => return Err(invalid_range("range must be one of 1h, 6h, 24h, 3d or 7d")),
    };
    Ok(definition)
}

fn validate_retention(value: u8) -> ApiResult<()> {
    if [1, 3, 7].contains(&value) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            ErrorCode::SystemMonitoringInvalidSettings,
            "retentionDays must be 1, 3 or 7",
        ))
    }
}

fn capabilities() -> SystemMonitoringCapabilities {
    SystemMonitoringCapabilities {
        can_manage_collection: true,
        can_clear_history: true,
    }
}

fn format_epoch(value: i64) -> ApiResult<String> {
    chrono::DateTime::from_timestamp(value, 0)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true))
        .ok_or_else(|| ApiError::internal("system monitoring timestamp is out of range"))
}

fn as_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|value| u64::try_from(value).ok())
}

fn invalid_range(message: &'static str) -> ApiError {
    ApiError::bad_request(ErrorCode::SystemMonitoringInvalidRange, message)
}

fn history_busy() -> ApiError {
    ApiError::conflict(
        ErrorCode::SystemMonitoringHistoryBusy,
        "system monitoring history maintenance is already running",
    )
}

fn database_error(error: sqlx::Error) -> ApiError {
    ApiError::database(error.to_string())
}

fn default_range() -> String {
    "24h".to_string()
}

fn default_sort() -> String {
    "asc".to_string()
}

fn default_limit() -> u16 {
    MAX_SERIES_LIMIT
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::FromRequestParts;
    use axum::http::{HeaderValue, Request};

    #[test]
    fn current_snapshots_are_grouped_nullable_and_age_independently() {
        use veydeck_contracts::monitoring::{CurrentCpuMetrics, CurrentMemoryMetrics};
        let sampled_since = Instant::now();
        let snapshot = CurrentHostSnapshot {
            sampled_at: 1000,
            sampled_since,
            metrics: sample(1000).to_raw().metrics(Some(&sample(940).to_raw())),
            cpu: CurrentCpuMetrics {
                cpu_percent: Some(50.0),
                user_percent: Some(30.0),
                system_percent: Some(15.0),
                io_wait_percent: Some(10.0),
            },
            memory: CurrentMemoryMetrics {
                total_bytes: Some(100),
                used_bytes: Some(40),
                usage_percent: Some(40.0),
                buffers_bytes: Some(0),
                cached_bytes: Some(30),
                available_bytes: Some(60),
                free_bytes: Some(20),
                other_used_bytes: Some(50),
                swap_total_bytes: Some(1000),
                swap_used_bytes: Some(250),
                swap_free_bytes: Some(750),
                swap_percent: Some(25.0),
            },
        };
        for sampled_at in [1000, 1_793_955_468, 1_893_955_468] {
            let shifted = CurrentHostSnapshot {
                sampled_at,
                ..snapshot.clone()
            };
            let current = build_current(
                Some(&shifted),
                SystemMonitoringGroup::Load,
                sampled_since + std::time::Duration::from_millis(2500),
            )
            .unwrap();
            assert_eq!(current.status, SystemMonitoringCurrentStatus::Fresh);
            assert_eq!(current.sample_age_ms, Some(2500));
        }
        for (group, keys) in [
            (
                SystemMonitoringGroup::Load,
                vec!["loadAverage1m", "loadAverage5m", "loadAverage15m"],
            ),
            (
                SystemMonitoringGroup::Cpu,
                vec![
                    "cpuPercent",
                    "userPercent",
                    "systemPercent",
                    "ioWaitPercent",
                ],
            ),
            (
                SystemMonitoringGroup::Memory,
                vec![
                    "totalBytes",
                    "usedBytes",
                    "usagePercent",
                    "buffersBytes",
                    "cachedBytes",
                    "availableBytes",
                    "freeBytes",
                    "otherUsedBytes",
                    "swapTotalBytes",
                    "swapUsedBytes",
                    "swapFreeBytes",
                    "swapPercent",
                ],
            ),
            (
                SystemMonitoringGroup::DiskIo,
                vec!["diskReadBytesPerSecond", "diskWriteBytesPerSecond"],
            ),
            (
                SystemMonitoringGroup::Network,
                vec![
                    "networkReceiveBytesPerSecond",
                    "networkTransmitBytesPerSecond",
                ],
            ),
        ] {
            let data = build_current(
                Some(&snapshot),
                group,
                sampled_since + std::time::Duration::from_secs(10),
            )
            .unwrap();
            assert_eq!(data.status, SystemMonitoringCurrentStatus::Fresh);
            assert_eq!(data.sample_age_ms, Some(10_000));
            let json = serde_json::to_value(&data).unwrap();
            assert_eq!(json["group"], group.as_str());
            let metrics = json["metrics"].as_object().unwrap();
            assert_eq!(metrics.len(), keys.len());
            assert!(keys.iter().all(|key| metrics.contains_key(*key)));
            let decoded: SystemMonitoringCurrent = serde_json::from_value(json).unwrap();
            assert_eq!(decoded, data);
            assert_eq!(
                build_current(
                    Some(&snapshot),
                    group,
                    sampled_since + std::time::Duration::from_millis(10_001)
                )
                .unwrap()
                .status,
                SystemMonitoringCurrentStatus::Stale
            );
            let empty = build_current(None, group, sampled_since).unwrap();
            assert_eq!(empty.status, SystemMonitoringCurrentStatus::Unavailable);
            assert!(empty.sampled_at.is_none());
            assert!(empty.sample_age_ms.is_none());
            assert!(
                serde_json::to_value(empty).unwrap()["metrics"]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(serde_json::Value::is_null)
            );
        }
    }

    #[tokio::test]
    async fn current_route_requires_group_and_reads_cache_without_history() {
        let state = Arc::new(crate::test_support::setup_test_state().await);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = Arc::clone(&state);
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                system_monitoring_router().with_state(server_state),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        for path in [
            "/current",
            "/current?group=invalid",
            "/current?group=cpu&range=1h",
        ] {
            assert_eq!(
                client
                    .get(format!("http://{address}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                400
            );
        }
        let data: serde_json::Value = client
            .get(format!("http://{address}/current?group=cpu"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(data["data"]["group"], "cpu");
        assert_eq!(data["data"]["status"], "unavailable");
        assert!(state.system_monitoring.current.read().await.is_none());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM system_monitoring_samples")
            .fetch_one(&state.metadata_db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        server.abort();
    }

    /// 构造不依赖其他来源质量的原始历史样本。
    fn sample(sampled_at: i64) -> StoredSample {
        StoredSample {
            sampled_at,
            cpu_percent: Some(0.0),
            memory_used_bytes: Some(50),
            memory_total_bytes: Some(100),
            memory_percent: Some(50.0),
            swap_percent: Some(25.0),
            load_average_1m: Some(1.0),
            load_average_5m: None,
            load_average_15m: Some(3.0),
            disk_read_bytes: Some(100),
            disk_write_bytes: Some(200),
            network_receive_bytes: Some(300),
            network_transmit_bytes: Some(400),
        }
    }

    #[test]
    fn grouped_history_preserves_gaps_nulls_and_zero_rates() {
        let rows = vec![sample(940), sample(1000), sample(1060)];
        let cpu = build_series_points(&rows, 1000, 1180, 60, SystemMonitoringGroup::Cpu).unwrap();
        assert_eq!(cpu.len(), 3);
        assert_eq!(cpu[0].coverage_percent, 100.0);
        assert_eq!(cpu[0].metrics.cpu_percent, Some(0.0));
        assert_eq!(cpu[2].coverage_percent, 0.0);
        assert_eq!(cpu[2].metrics.cpu_percent, None);
        let load = build_series_points(&rows, 1000, 1180, 60, SystemMonitoringGroup::Load).unwrap();
        assert!((load[0].coverage_percent - 200.0 / 3.0).abs() < 0.001);
        let disk =
            build_series_points(&rows, 1000, 1180, 60, SystemMonitoringGroup::DiskIo).unwrap();
        assert_eq!(disk[0].metrics.disk_read_bytes_per_second, Some(0.0));
        assert_eq!(disk[0].coverage_percent, 100.0);
        let first = build_series_points(&rows[1..], 1000, 1180, 60, SystemMonitoringGroup::Network)
            .unwrap();
        assert_eq!(first[0].metrics.network_receive_bytes_per_second, None);
        assert_eq!(first[0].coverage_percent, 0.0);
    }

    #[test]
    fn swap_history_aggregates_zero_values_and_preserves_missing_buckets() {
        let mut first = sample(1000);
        first.swap_percent = Some(0.0);
        let mut second = sample(1060);
        second.swap_percent = Some(50.0);
        let points = build_series_points(
            &[first, second],
            1000,
            1360,
            120,
            SystemMonitoringGroup::Memory,
        )
        .unwrap();
        assert_eq!(points[0].metrics.swap_percent, Some(25.0));
        assert_eq!(points[1].metrics.swap_percent, None);
        let projected =
            serde_json::to_value(project_series(SystemMonitoringGroup::Memory, points)).unwrap();
        assert_eq!(projected["points"][0]["metrics"]["swapPercent"], 25.0);
        assert!(projected["points"][1]["metrics"]["swapPercent"].is_null());
    }

    #[tokio::test]
    async fn grouped_api_round_trips_only_requested_metrics_and_removes_overview() {
        use axum::body::to_bytes;
        let state = Arc::new(crate::test_support::setup_test_state().await);
        let now = Utc::now().timestamp();
        sqlx::query("INSERT INTO system_monitoring_samples (sampled_at, cpu_percent, memory_percent, load_average_1m, load_average_5m, load_average_15m, disk_read_bytes, disk_write_bytes, network_receive_bytes, network_transmit_bytes, available_source_count) VALUES (?, 0, 50, 1, NULL, 3, 100, 200, 300, 400, 1)")
            .bind(now - 60).execute(&state.metadata_db).await.unwrap();
        *state.system_monitoring.collection_state.write().await =
            SystemMonitoringCollectionState::Stopped;
        for (group, fields) in [
            (
                SystemMonitoringGroup::Load,
                vec!["loadAverage1m", "loadAverage5m", "loadAverage15m"],
            ),
            (SystemMonitoringGroup::Cpu, vec!["cpuPercent"]),
            (
                SystemMonitoringGroup::Memory,
                vec!["memoryPercent", "swapPercent"],
            ),
            (
                SystemMonitoringGroup::DiskIo,
                vec!["diskReadBytesPerSecond", "diskWriteBytesPerSecond"],
            ),
            (
                SystemMonitoringGroup::Network,
                vec![
                    "networkReceiveBytesPerSecond",
                    "networkTransmitBytesPerSecond",
                ],
            ),
        ] {
            let response = series(
                State(Arc::clone(&state)),
                Query(SystemMonitoringSeriesQuery {
                    group,
                    range: "1h".into(),
                    sort: "asc".into(),
                    limit: 500,
                    cursor: None,
                }),
            )
            .await
            .unwrap();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let data = &body["data"];
            assert_eq!(data["group"], group.as_str());
            assert_eq!(data["collectionState"], "stopped");
            assert_eq!(data["expectedPointCount"], 60);
            assert_eq!(data["points"].as_array().unwrap().len(), 60);
            for point in data["points"].as_array().unwrap() {
                let metrics = point["metrics"].as_object().unwrap();
                assert_eq!(metrics.len(), fields.len());
                assert!(fields.iter().all(|field| metrics.contains_key(*field)));
            }
            // 模拟 Master 的强类型解码和重新编码，保证字段不膨胀。
            let decoded: SystemMonitoringSeriesPage = serde_json::from_value(data.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), *data);
        }
        let response = series(
            State(Arc::clone(&state)),
            Query(SystemMonitoringSeriesQuery {
                group: SystemMonitoringGroup::Cpu,
                range: "1h".into(),
                sort: "desc".into(),
                limit: 2,
                cursor: None,
            }),
        )
        .await
        .unwrap();
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["data"]["points"].as_array().unwrap().len(), 2);
        assert_eq!(body["data"]["pageInfo"]["nextCursor"], "2");

        // 使用真实路由验证已删除接口，以及 Query 提取器对缺失/非法分组的拒绝。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, system_monitoring_router().with_state(state))
                .await
                .unwrap();
        });
        let client = reqwest::Client::new();
        for (path, status) in [
            ("/overview", 404),
            ("/series?range=1h", 400),
            ("/series?group=invalid", 400),
        ] {
            assert_eq!(
                client
                    .get(format!("http://{address}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                status
            );
        }
        server.abort();
    }

    #[test]
    fn grouped_payload_is_smaller_than_full_metrics() {
        let metrics = sample(1000).to_raw().metrics(Some(&sample(940).to_raw()));
        let point = SystemMonitoringSeriesPoint {
            sampled_at: "2026-11-06T00:00:00Z".into(),
            coverage_percent: 100.0,
            metrics,
        };
        let full = serde_json::to_vec(&point).unwrap().len();
        for group in [
            SystemMonitoringGroup::Load,
            SystemMonitoringGroup::Cpu,
            SystemMonitoringGroup::Memory,
            SystemMonitoringGroup::DiskIo,
            SystemMonitoringGroup::Network,
        ] {
            let value = serde_json::to_value(project_series(group, vec![point.clone()])).unwrap();
            assert!(serde_json::to_vec(&value["points"][0]).unwrap().len() < full);
        }
    }

    #[test]
    fn range_uses_stable_resolution() {
        assert_eq!(parse_range("1h").unwrap().resolution_seconds, 60);
        assert_eq!(parse_range("24h").unwrap().resolution_seconds, 300);
        assert_eq!(parse_range("7d").unwrap().resolution_seconds, 1_800);
        assert!(parse_range("30d").is_err());
    }

    #[test]
    fn retention_accepts_only_supported_values() {
        for value in [1, 3, 7] {
            assert!(validate_retention(value).is_ok());
        }
        assert!(validate_retention(2).is_err());
    }

    #[test]
    fn settings_payload_rejects_unknown_fields() {
        let payload = serde_json::json!({
            "historyCollectionEnabled": true,
            "retentionDays": 7,
            "force": true,
        });
        assert!(serde_json::from_value::<SystemMonitoringSettingsUpdate>(payload).is_err());
    }

    #[tokio::test]
    async fn mutations_require_trusted_operation_context() {
        let request = Request::builder().body(()).unwrap();
        let (mut parts, _) = request.into_parts();
        assert!(
            TrustedOperationContext::from_request_parts(&mut parts, &())
                .await
                .is_err()
        );

        parts
            .headers
            .insert(&ACTOR_KIND_HEADER, HeaderValue::from_static("user"));
        parts
            .headers
            .insert(&ACTOR_NAME_HEADER, HeaderValue::from_static("admin"));
        assert!(
            TrustedOperationContext::from_request_parts(&mut parts, &())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn settings_update_is_transactional_and_updates_runtime() {
        let state = Arc::new(crate::test_support::setup_test_state().await);
        update_settings(
            State(Arc::clone(&state)),
            TrustedOperationContext,
            Ok(Json(SystemMonitoringSettingsUpdate {
                history_collection_enabled: false,
                retention_days: 3,
            })),
        )
        .await
        .unwrap();

        let stored = crate::services::system_monitoring::load_storage_settings(&state.metadata_db)
            .await
            .unwrap();
        assert!(!stored.history_collection_enabled);
        assert_eq!(stored.retention_days, 3);
        assert_eq!(
            *state.system_monitoring.collection_state.read().await,
            SystemMonitoringCollectionState::Stopped
        );
    }

    #[tokio::test]
    async fn overlapping_history_maintenance_returns_conflict() {
        let state = Arc::new(crate::test_support::setup_test_state().await);
        let _guard = state.system_monitoring.maintenance.lock().await;
        let error = clear_history(State(Arc::clone(&state)), TrustedOperationContext)
            .await
            .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(error.code, ErrorCode::SystemMonitoringHistoryBusy);
    }
}
