//! Linux CPU 时间差值与内存结构采集；同一采样结果供历史与实时展示使用。

use veydeck_contracts::monitoring::{CurrentCpuMetrics, CurrentMemoryMetrics};

/// 读取聚合 CPU 的前八个时间计数，guest 已包含在 user 中，不重复求和。
pub fn read_cpu_times() -> Option<[u64; 8]> {
    parse_cpu_times(&std::fs::read_to_string("/proc/stat").ok()?)
}

/// 解析聚合 CPU 行，不使用单核行。
fn parse_cpu_times(content: &str) -> Option<[u64; 8]> {
    let mut fields = content.lines().next()?.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let mut times = [0; 8];
    for time in &mut times {
        *time = fields.next()?.parse().ok()?;
    }
    Some(times)
}

/// 由相邻计数计算全部 CPU 百分比；无基线、回退或零间隔时保留缺失值。
pub fn cpu_usage(current: Option<[u64; 8]>, previous: Option<[u64; 8]>) -> CurrentCpuMetrics {
    let (Some(current), Some(previous)) = (current, previous) else {
        return CurrentCpuMetrics::default();
    };
    let Some(deltas) = current
        .iter()
        .zip(previous)
        .map(|(now, old)| now.checked_sub(old))
        .collect::<Option<Vec<_>>>()
    else {
        return CurrentCpuMetrics::default();
    };
    let Some(total) = deltas
        .iter()
        .try_fold(0_u64, |sum, value| sum.checked_add(*value))
        .filter(|total| *total > 0)
    else {
        return CurrentCpuMetrics::default();
    };
    let percent = |value: u64| Some(value as f64 / total as f64 * 100.0);
    CurrentCpuMetrics {
        cpu_percent: percent(total - deltas[3] - deltas[4]),
        user_percent: percent(deltas[0] + deltas[1]),
        system_percent: percent(deltas[2] + deltas[5] + deltas[6]),
        io_wait_percent: percent(deltas[4]),
    }
}

/// 从同次 meminfo 读取内存结构，不将缺失字段当作零。
pub fn read_memory() -> CurrentMemoryMetrics {
    std::fs::read_to_string("/proc/meminfo")
        .map(|content| parse_memory(&content))
        .unwrap_or_default()
}

/// 将 Linux kB 转换为字节；可用内存与缓冲、缓存重叠，不能相加。
fn parse_memory(content: &str) -> CurrentMemoryMetrics {
    let field = |name: &str| {
        content.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key != name {
                return None;
            }
            let mut parts = value.split_whitespace();
            let amount = parts.next()?.parse::<u64>().ok()?;
            (parts.next()? == "kB").then_some(amount)?.checked_mul(1024)
        })
    };
    let total_bytes = field("MemTotal").filter(|total| *total > 0);
    let available_bytes = field("MemAvailable")
        .filter(|available| total_bytes.is_none_or(|total| *available <= total));
    let used_bytes = total_bytes
        .zip(available_bytes)
        .and_then(|(total, available)| total.checked_sub(available));
    let free_bytes = field("MemFree").filter(|free| total_bytes.is_none_or(|total| *free <= total));
    let buffers_bytes = field("Buffers");
    let cached_bytes = field("Cached");
    // 构成项必须完整且不超出总量；不能用零或截断掩盖不一致的采样。
    let other_used_bytes = total_bytes
        .zip(free_bytes)
        .zip(buffers_bytes)
        .zip(cached_bytes)
        .and_then(|(((total, free), buffers), cached)| {
            total
                .checked_sub(free)?
                .checked_sub(buffers)?
                .checked_sub(cached)
        });
    let swap_total_bytes = field("SwapTotal");
    let swap_free_bytes =
        field("SwapFree").filter(|free| swap_total_bytes.is_none_or(|total| *free <= total));
    let swap_used_bytes = swap_total_bytes
        .zip(swap_free_bytes)
        .and_then(|(total, free)| total.checked_sub(free));
    let swap_percent = swap_used_bytes
        .zip(swap_total_bytes.filter(|total| *total > 0))
        .map(|(used, total)| used as f64 / total as f64 * 100.0);
    CurrentMemoryMetrics {
        swap_total_bytes,
        swap_free_bytes,
        swap_used_bytes,
        swap_percent,
        total_bytes,
        available_bytes,
        used_bytes,
        usage_percent: used_bytes
            .zip(total_bytes)
            .map(|(used, total)| used as f64 / total as f64 * 100.0),
        buffers_bytes,
        cached_bytes,
        free_bytes,
        other_used_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_uses_first_eight_counters_and_consistent_percentages() {
        let current = parse_cpu_times("cpu 20 10 10 40 10 2 3 5 999 888\ncpu0 1 2 3").unwrap();
        let metrics = cpu_usage(Some(current), Some([0; 8]));
        assert_eq!(metrics.cpu_percent, Some(50.0));
        assert_eq!(metrics.user_percent, Some(30.0));
        assert_eq!(metrics.system_percent, Some(15.0));
        assert_eq!(metrics.io_wait_percent, Some(10.0));
        assert!(parse_cpu_times("cpu0 1 2 3 4 5 6 7 8").is_none());
        assert!(parse_cpu_times("cpu 1 2 invalid").is_none());
    }

    #[test]
    fn cpu_missing_baseline_zero_interval_and_regression_stay_null() {
        assert_eq!(cpu_usage(Some([1; 8]), None), CurrentCpuMetrics::default());
        assert_eq!(cpu_usage(None, Some([1; 8])), CurrentCpuMetrics::default());
        assert_eq!(
            cpu_usage(Some([1; 8]), Some([1; 8])),
            CurrentCpuMetrics::default()
        );
        let mut regressed = [2; 8];
        regressed[4] = 0;
        assert_eq!(
            cpu_usage(Some(regressed), Some([1; 8])),
            CurrentCpuMetrics::default()
        );
        assert_eq!(
            cpu_usage(Some([u64::MAX; 8]), Some([0; 8])),
            CurrentCpuMetrics::default()
        );
    }

    #[test]
    fn memory_uses_available_and_preserves_individual_missing_fields() {
        let memory = parse_memory(
            "MemTotal: 1000 kB\nMemAvailable: 600 kB\nMemFree: 100 kB\nBuffers: 0 kB\nCached: 300 kB\n",
        );
        assert_eq!(memory.total_bytes, Some(1_024_000));
        assert_eq!(memory.used_bytes, Some(409_600));
        assert_eq!(memory.usage_percent, Some(40.0));
        assert_eq!(memory.buffers_bytes, Some(0));
        assert_eq!(memory.cached_bytes, Some(307_200));
        assert_eq!(memory.free_bytes, Some(102_400));
        assert_eq!(memory.other_used_bytes, Some(614_400));
        assert_eq!(
            memory.other_used_bytes.unwrap()
                + memory.free_bytes.unwrap()
                + memory.buffers_bytes.unwrap()
                + memory.cached_bytes.unwrap(),
            memory.total_bytes.unwrap()
        );
        let partial = parse_memory("MemTotal: 1000 kB\nCached: 300 kB");
        assert_eq!(partial.used_bytes, None);
        assert_eq!(partial.buffers_bytes, None);
        assert_eq!(partial.cached_bytes, Some(307_200));
        assert_eq!(parse_memory("MemTotal: 0 kB").usage_percent, None);
        assert_eq!(
            parse_memory("MemTotal: 1 kB\nMemAvailable: 2 kB").used_bytes,
            None
        );
    }
    #[test]
    fn swap_units_missing_fields_zero_and_invalid_counts() {
        let memory = parse_memory("SwapTotal: 1000 kB\nSwapFree: 750 kB");
        assert_eq!(memory.swap_total_bytes, Some(1_024_000));
        assert_eq!(memory.swap_free_bytes, Some(768_000));
        assert_eq!(memory.swap_used_bytes, Some(256_000));
        assert_eq!(memory.swap_percent, Some(25.0));
        assert_eq!(
            parse_memory("SwapTotal: 1000 kB\nSwapFree: 1000 kB").swap_percent,
            Some(0.0)
        );
        let disabled = parse_memory("SwapTotal: 0 kB\nSwapFree: 0 kB");
        assert_eq!(disabled.swap_total_bytes, Some(0));
        assert_eq!(disabled.swap_percent, None);
        assert_eq!(parse_memory("SwapTotal: 1000 kB").swap_used_bytes, None);
        assert_eq!(
            parse_memory("SwapTotal: 1 kB\nSwapFree: 2 kB").swap_free_bytes,
            None
        );
        assert_eq!(parse_memory("").swap_total_bytes, None);
    }

    #[test]
    fn memory_composition_preserves_missing_values_and_rejects_inconsistent_totals() {
        let partial =
            parse_memory("MemTotal: 1000 kB\nMemAvailable: 600 kB\nBuffers: 0 kB\nCached: 300 kB");
        assert_eq!(partial.free_bytes, None);
        assert_eq!(partial.other_used_bytes, None);
        assert_eq!(partial.used_bytes, Some(409_600));
        let invalid =
            parse_memory("MemTotal: 100 kB\nMemFree: 90 kB\nBuffers: 20 kB\nCached: 30 kB");
        assert_eq!(invalid.other_used_bytes, None);
        let zero = parse_memory("MemTotal: 100 kB\nMemFree: 100 kB\nBuffers: 0 kB\nCached: 0 kB");
        assert_eq!(zero.other_used_bytes, Some(0));
        let no_available =
            parse_memory("MemTotal: 100 kB\nMemFree: 20 kB\nBuffers: 10 kB\nCached: 30 kB");
        assert_eq!(no_available.other_used_bytes, Some(40 * 1024));
        assert_eq!(no_available.used_bytes, None);
    }
}
