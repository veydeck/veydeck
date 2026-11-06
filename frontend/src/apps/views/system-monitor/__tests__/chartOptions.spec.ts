import { describe, expect, it } from 'vitest'
import {
  buildCpuChartOptions,
  buildLoadChartOptions,
  buildMemoryChartOptions,
  buildDiskIoChartOptions,
  buildNetworkChartOptions,
} from '../chartOptions'

const theme = {
  titleColor: '#111',
  textColor: '#222',
  gridLineColor: '#333',
  tooltipBackground: '#fff',
  tooltipBorder: '#ddd',
  primary: '#00f',
  success: '#0f0',
  warning: '#f90',
}

describe('system monitoring chart options', () => {
  it('平均负载显示最多两位小数且保留原始采样精度', () => {
    const options = buildLoadChartOptions(['a'], [1.23456], [1.2], [1], theme, {
      load1: '1m',
      load5: '5m',
      load15: '15m',
    })
    const tooltip = options.tooltip as { valueFormatter: (value: unknown) => string }
    const yAxis = options.yAxis as {
      axisLabel: { formatter: (value: unknown) => string }
    }
    const series = options.series as Array<{ data: Array<number | null> }>

    expect(tooltip.valueFormatter(1.23456)).toBe('1.23')
    expect(tooltip.valueFormatter(1.2)).toBe('1.2')
    expect(yAxis.axisLabel.formatter(1.236)).toBe('1.24')
    expect(series[0]?.data).toEqual([1.23456])
  })

  it('时间轴滑块与 X 轴滚轮缩放联动，缩放不删除缺失点', () => {
    const options = buildCpuChartOptions(['a', 'b'], [12, 18], theme, 'CPU')
    const dataZoom = options.dataZoom as Array<Record<string, unknown>>
    expect(dataZoom).toHaveLength(2)
    expect(dataZoom[0]).toMatchObject({ type: 'slider', xAxisIndex: 0, filterMode: 'none' })
    expect(dataZoom[1]).toMatchObject({
      type: 'inside',
      xAxisIndex: 0,
      filterMode: 'none',
      zoomOnMouseWheel: true,
      moveOnMouseWheel: false,
      moveOnMouseMove: false,
    })
    expect(dataZoom[1]).not.toHaveProperty('yAxisIndex')
  })

  it('保留缺失点并禁止连接不存在的趋势', () => {
    const options = buildCpuChartOptions(['a', 'b', 'c'], [12, null, 18], theme, 'CPU')
    const series = (options.series as Array<Record<string, unknown>>)[0]

    expect(series?.data).toEqual([12, null, 18])
    expect(series?.connectNulls).toBe(false)
  })
  it('所有分组保留 null 断点，提示缺失值时不转换为零', () => {
    const labels = ['a', 'b', 'c']
    const values = [0, null, 2]
    const scale = { base: 1024, unit: 'KiB/s' }
    const options = [
      buildLoadChartOptions(labels, values, values, values, theme, {
        load1: '1m',
        load5: '5m',
        load15: '15m',
      }),
      buildCpuChartOptions(labels, values, theme, 'CPU'),
      buildMemoryChartOptions(labels, values, theme, '内存'),
      buildDiskIoChartOptions(labels, values, values, scale, theme, { read: '读', write: '写' }),
      buildNetworkChartOptions(labels, values, values, scale, theme, { rx: '收', tx: '发' }),
    ]
    for (const option of options) {
      for (const series of option.series as Array<Record<string, unknown>>) {
        expect(series.data).toEqual(values)
        expect(series.connectNulls).toBe(false)
      }
      const tooltip = option.tooltip as { valueFormatter: (value: unknown) => string }
      expect(tooltip.valueFormatter(null)).toBe('—')
      expect(tooltip.valueFormatter(undefined)).toBe('—')
      expect(tooltip.valueFormatter(0)).not.toBe('—')
    }
  })
})
