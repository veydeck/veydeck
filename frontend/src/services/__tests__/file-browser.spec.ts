import { describe, it, expect } from 'vitest'
import { normalizeFilePath, selectFileRange, validateFileAction } from '../file-browser'
import type { FsEntry } from '@/api/interface/fs'
/** 生成固定路径的文件摘要。 */
const entry = (name: string, kind: FsEntry['kind'] = 'file') =>
  ({
    name,
    path: '/source/' + name,
    kind,
    revision: 'v1',
    management: { kind: 'custom' },
    capabilities: { canCopy: true, canRemove: true },
  }) as FsEntry
describe('file browser rules', () => {
  it('拒绝跨节点、原位置、目录后代和超过 500 项，不把相似前缀误判为后代', () => {
    const files = [entry('folder', 'directory')]
    expect(validateFileAction('a', 'b', files, '/target')).toBe('differentNode')
    expect(validateFileAction('a', 'a', files, '/source')).toBe('invalidTarget')
    expect(validateFileAction('a', 'a', files, '/source/folder/sub')).toBe('invalidTarget')
    expect(validateFileAction('a', 'a', files, '/source/folder-other')).toBeUndefined()
    expect(
      validateFileAction(
        'a',
        'a',
        Array.from({ length: 501 }, () => entry('a')),
        '/target',
      ),
    ).toBe('tooMany')
  })
  it('切换选择和区间选择均依据完整有序模型，不依赖虚拟 DOM', () => {
    const entries = Array.from({ length: 10000 }, (_, i) => entry(String(i)))
    expect(
      selectFileRange(entries, new Set(['/source/1']), '/source/1', undefined, true, false).size,
    ).toBe(0)
    const range = selectFileRange(entries, new Set(), '/source/9999', '/source/9990', false, true)
    expect(range.size).toBe(10)
    expect(range.has('/source/9995')).toBe(true)
    expect(normalizeFilePath('//source/./folder/')).toBe('/source/folder')
    expect(() => normalizeFilePath('/source/../target')).toThrow()
  })
})
