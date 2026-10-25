import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { localizeErrorSummary } from '@/api/error'

const initialLocale = i18n.global.locale.value

afterEach(() => {
  i18n.global.locale.value = initialLocale
})

describe('业务错误提示', () => {
  it('按当前语言显示接管操作，并随语言切换更新', () => {
    i18n.global.locale.value = 'zh'
    expect(localizeErrorSummary('SUITE_RETAINED_DATA_REQUIRES_ADOPTION', 'technical detail')).toBe(
      '检测到此前保留的套件数据，请勾选“接管此前保留的套件数据”后重新安装。',
    )
    i18n.global.locale.value = 'en'
    expect(
      localizeErrorSummary('SUITE_RETAINED_DATA_REQUIRES_ADOPTION', 'technical detail'),
    ).toContain('Select “Adopt previously retained suite data”')
  })

  it('区分数据占用和需要接管，未知错误保留公开摘要', () => {
    i18n.global.locale.value = 'zh'
    expect(localizeErrorSummary('SUITE_RESOURCE_IN_USE', 'technical detail')).toBe(
      '该套件的数据正在被其他实例使用，请先卸载原实例。',
    )
    expect(localizeErrorSummary('UNKNOWN_ERROR', '公开错误摘要')).toBe('公开错误摘要')
    expect(localizeErrorSummary(undefined, undefined)).toBe('')
  })
})
