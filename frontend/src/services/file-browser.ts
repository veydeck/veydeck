/** 文件浏览器共享的路径、选择与操作规则。 */
import type { FsEntry, FsEntryDetail } from '@/api/interface/fs'

/** 校验绝对路径并消除重复分隔符，不接受父目录跳转片段。 */
export function normalizeFilePath(value: string): string {
  const text = value.trim()
  if (!text.startsWith('/') || text.includes('\0') || text.split('/').includes('..'))
    throw new Error('invalidPath')
  return (
    '/' +
    text
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/')
  )
}
/** 返回文件父目录。 */
export function fileParent(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}
/** 将条目名称放入目标目录。 */
export function fileTarget(directory: string, name: string): string {
  return `${directory === '/' ? '' : directory}/${name}`
}
/** 校验同节点操作、条目上限及源目标关系。 */
export function validateFileAction(
  sourceNode: string,
  targetNode: string,
  entries: FsEntry[],
  directory: string,
): string | undefined {
  if (sourceNode !== targetNode) return 'differentNode'
  if (!entries.length) return 'emptySelection'
  if (entries.length > 500) return 'tooMany'
  const target = normalizeFilePath(directory)
  if (
    entries.some((entry) => {
      const destination = fileTarget(target, entry.name)
      return (
        destination === entry.path ||
        (entry.kind === 'directory' &&
          (target === entry.path || target.startsWith(entry.path + '/')))
      )
    })
  )
    return 'invalidTarget'
}
/** 按有序目录模型计算单选、切换或连续选择。 */
export function selectFileRange(
  entries: FsEntry[],
  selected: Set<string>,
  path: string,
  anchor: string | undefined,
  toggle: boolean,
  range: boolean,
): Set<string> {
  if (range && anchor) {
    const from = entries.findIndex((entry) => entry.path === anchor)
    const to = entries.findIndex((entry) => entry.path === path)
    if (from >= 0 && to >= 0)
      return new Set([
        ...(toggle ? selected : []),
        ...entries.slice(Math.min(from, to), Math.max(from, to) + 1).map((entry) => entry.path),
      ])
  }
  if (toggle) {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  }
  return new Set([path])
}

/** 目录路径可通过链接进入，创建子项时使用最终目录的能力。 */
export function fileDirectoryCapabilities(entry: FsEntryDetail) {
  return entry.symlinkTargetCapabilities || entry.capabilities
}
