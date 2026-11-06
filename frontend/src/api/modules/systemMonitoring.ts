/**
 * @file systemMonitoring.ts
 * @description 系统监控领域 API，仅通过 Master 的单节点语义网关访问。
 */

import http from '@/api'
import type {
  SystemMonitoringCurrent,
  SystemMonitoringSeriesPage,
  SystemMonitoringSettings,
} from '@/api/generated'

export type SystemMonitoringRange = '1h' | '6h' | '24h' | '3d' | '7d'

export interface SystemMonitoringSettingsUpdate {
  historyCollectionEnabled: boolean
  retentionDays: 1 | 3 | 7
}

export interface ClearSystemMonitoringHistoryResult {
  clearedSampleCount: number
}

const nodePath = (nodeId: string, suffix: string) =>
  `/node/${encodeURIComponent(nodeId || 'local')}/system-monitoring${suffix}`

export const systemMonitoringApi = {
  /** 读取当前指标组的实时缓存，不触发主机采样。 */
  fetchCurrent(nodeId: string, group: SystemMonitoringCurrent['group']) {
    return http.get<SystemMonitoringCurrent>(nodePath(nodeId, '/current'), { group })
  },
  fetchSeries(
    nodeId: string,
    range: SystemMonitoringRange,
    group: SystemMonitoringSeriesPage['group'],
  ) {
    return http.get<SystemMonitoringSeriesPage>(nodePath(nodeId, '/series'), {
      range,
      group,
      sort: 'asc',
      limit: 500,
    })
  },
  fetchSettings(nodeId: string) {
    return http.get<SystemMonitoringSettings>(nodePath(nodeId, '/settings'))
  },
  updateSettings(nodeId: string, payload: SystemMonitoringSettingsUpdate) {
    return http.put<SystemMonitoringSettings>(nodePath(nodeId, '/settings'), payload)
  },
  clearHistory(nodeId: string) {
    return http.delete<ClearSystemMonitoringHistoryResult>(nodePath(nodeId, '/history'))
  },
}
