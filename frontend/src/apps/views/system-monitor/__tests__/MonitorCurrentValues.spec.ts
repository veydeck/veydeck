import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import MonitorCurrentValues from '../MonitorCurrentValues.vue'
import { VeyTooltip } from '@/components/ui'
import type { SystemMonitoringCurrent } from '@/api/generated'
import zh from '@/locales/zh'

/** 独立验证资源区的标签、单位及缺失值。 */
const render = (
  snapshot: SystemMonitoringCurrent | null,
  group: SystemMonitoringCurrent['group'] = snapshot?.group ?? 'load',
) =>
  mount(MonitorCurrentValues, {
    props: { group, snapshot, loading: false, error: '', stale: false },
    global: {
      plugins: [createPinia(), createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
    },
  })
const base = { sampledAt: null, sampleAgeMs: 0, status: 'fresh' as const }
describe('MonitorCurrentValues', () => {
  it('负载显示零、两位精度与缺失占位', () => {
    const wrapper = render({
      ...base,
      group: 'load',
      metrics: { loadAverage1m: 0, loadAverage5m: 1.234, loadAverage15m: null },
    })
    expect(wrapper.findAll('dd').map((node) => node.text())).toEqual(['0', '1.23', '—'])
    expect(wrapper.findAll('dt').map((node) => node.text())).toEqual([
      '1 分钟',
      '5 分钟',
      '15 分钟',
    ])
  })
  it('CPU 显示四个百分比，不伪造首次采样', () => {
    const wrapper = render({
      ...base,
      group: 'cpu',
      metrics: { cpuPercent: 40, userPercent: 0, systemPercent: 12.345, ioWaitPercent: null },
    })
    expect(
      wrapper.get('[data-ui="cpu-breakdown"]').findAll('[data-ui="current-metric"]'),
    ).toHaveLength(3)
    expect(wrapper.findAll('dd').map((node) => node.text())).toEqual([
      '40.0%',
      '0.0%',
      '12.3%',
      '—',
    ])
    expect(
      render(null, 'cpu')
        .findAll('dd')
        .map((node) => node.text()),
    ).toEqual(['—', '—', '—', '—'])
  })
  it('内存提供四项摘要及四段构成，不展示系统保留', () => {
    const wrapper = render({
      ...base,
      group: 'memory',
      metrics: {
        swapTotalBytes: 2048,
        swapUsedBytes: 512,
        swapFreeBytes: 1536,
        swapPercent: 25,
        totalBytes: 1024,
        usedBytes: 512,
        usagePercent: 50,
        buffersBytes: 0,
        cachedBytes: 256,
        availableBytes: 512,
        freeBytes: 256,
        otherUsedBytes: 512,
      },
    })
    expect(wrapper.findAll('[data-ui="current-metric"]')).toHaveLength(4)
    expect(wrapper.find('[data-ui="memory-details"]').exists()).toBe(false)
    expect(wrapper.findAll('.metric-grid dt').map((node) => node.text())).toEqual([
      '利用率',
      '总计',
      '已用',
      '可用',
    ])
    expect(wrapper.get('[data-metric="totalBytes"] dd').text()).toBe('1.0 KB')
    expect(wrapper.find('[data-metric="buffersBytes"]').exists()).toBe(false)
    expect(wrapper.find('[data-metric="cachedBytes"]').exists()).toBe(false)
    const segments = wrapper.findAll('[data-ui="memory-segment"]')
    expect(segments).toHaveLength(4)
    expect(segments.map((segment) => segment.attributes('data-segment'))).toEqual([
      'otherUsedBytes',
      'buffersBytes',
      'cachedBytes',
      'freeBytes',
    ])
    expect(segments.map((segment) => (segment.element as HTMLElement).style.width)).toEqual([
      '50%',
      '0%',
      '25%',
      '25%',
    ])
    expect(wrapper.get('[data-ui="memory-usage"]').attributes('aria-label')).toContain('已使用')
    expect(wrapper.get('[data-ui="memory-legend"]').text()).toContain('空闲')
    expect(wrapper.findAll('[title]')).toHaveLength(0)
    expect(
      wrapper
        .findAllComponents(VeyTooltip)
        .some((tooltip) => tooltip.props('text').includes('512 B (50.0%)')),
    ).toBe(true)
    expect(wrapper.find('[data-slot="memory-note"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('当前值')
    expect(wrapper.text()).not.toContain('已保留')
    expect(wrapper.text()).not.toContain('系统保留')
    expect(wrapper.text()).not.toContain('其他已用')
  })
  it('Swap 显示三项摘要和已用、空闲两段，切换不混用物理内存数值', async () => {
    const wrapper = render({
      ...base,
      group: 'memory',
      metrics: {
        totalBytes: 8192,
        usedBytes: 4096,
        usagePercent: 50,
        availableBytes: 4096,
        buffersBytes: 0,
        cachedBytes: 2048,
        freeBytes: 2048,
        otherUsedBytes: 4096,
        swapTotalBytes: 2048,
        swapUsedBytes: 512,
        swapFreeBytes: 1536,
        swapPercent: 25,
      },
    })
    await wrapper.setProps({ memoryType: 'swap' })
    expect(wrapper.findAll('dd').map((node) => node.text())).toEqual(['25.0%', '2.0 KB', '512 B'])
    expect(
      wrapper
        .findAll('[data-ui="memory-segment"]')
        .map((segment) => (segment.element as HTMLElement).style.width),
    ).toEqual(['25%', '75%'])
    expect(wrapper.find('[data-metric="availableBytes"]').exists()).toBe(false)
    expect(
      wrapper
        .findAllComponents(VeyTooltip)
        .every((tooltip) => !tooltip.props('text').includes('可用')),
    ).toBe(true)
    await wrapper.setProps({ memoryType: 'physical' })
    expect(wrapper.get('[data-metric="totalBytes"] dd').text()).toBe('8.0 KB')
    expect(wrapper.findAll('[data-ui="memory-segment"]')).toHaveLength(4)
    wrapper.unmount()
  })

  it('缺失构成项时不把未知内存画成零，已有主读数仍显示', () => {
    const wrapper = render({
      ...base,
      group: 'memory',
      metrics: {
        swapTotalBytes: 2048,
        swapUsedBytes: 512,
        swapFreeBytes: 1536,
        swapPercent: 25,
        totalBytes: 1024,
        usedBytes: 512,
        usagePercent: 50,
        buffersBytes: 0,
        cachedBytes: null,
        availableBytes: 512,
        freeBytes: null,
        otherUsedBytes: null,
      },
    })
    expect(wrapper.find('[data-ui="memory-composition"]').exists()).toBe(false)
    expect(wrapper.get('[data-metric="usedBytes"] dd').text()).toBe('512 B')
    expect(wrapper.get('[data-metric="availableBytes"] dd').text()).toBe('512 B')
    expect(wrapper.findAll('.metric-grid [data-ui="current-metric"]')).toHaveLength(4)
  })

  it('磁盘与网络使用速率单位', () => {
    const disk = render({
      ...base,
      group: 'diskIo',
      metrics: { diskReadBytesPerSecond: 1024, diskWriteBytesPerSecond: 0 },
    })
    expect(disk.findAll('dd').map((node) => node.text())).toEqual(['1.00 KB/s', '0.00 B/s'])
    const net = render({
      ...base,
      group: 'network',
      metrics: { networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: 1048576 },
    })
    expect(net.findAll('dd').map((node) => node.text())).toEqual(['—', '1.00 MB/s'])
  })
  it('请求失败和过期显示底部提示，并保留已取得数值', async () => {
    const wrapper = render({
      ...base,
      group: 'load',
      metrics: { loadAverage1m: 1, loadAverage5m: 2, loadAverage15m: 3 },
    })
    await wrapper.setProps({ stale: true })
    expect(wrapper.get('[data-ui="current-notice"]').text()).toContain('已过期')
    await wrapper.setProps({ error: '请求失败' })
    expect(wrapper.get('[data-ui="current-notice"]').text()).toContain('请求失败')
    expect(wrapper.get('[data-ui="current-notice"]').text()).toContain('已过期')
    expect(wrapper.findAll('dd').map((node) => node.text())).toEqual(['1', '2', '3'])
  })
})
