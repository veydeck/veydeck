import { describe, it, expect } from 'vitest'
import { captureDroppedFiles } from '../file-drop'
/** 构造可同步捕获、异步读取的浏览器文件条目。 */
function fileEntry(name: string): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: File) => void) => resolve(new File([''], name)),
  } as unknown as FileSystemEntry
}
/** 每次只返回一批条目，模拟浏览器目录读取器的真实分页。 */
function directory(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
        resolve(batches.shift() || []),
    }),
  } as unknown as FileSystemEntry
}
describe('file drop capture', () => {
  it('同步保存拖入引用，遍历所有目录批次并保留相对路径和零字节文件', async () => {
    const root = directory('project', [
      [fileEntry('empty.txt')],
      [directory('sub', [[fileEntry('config.json')]])],
    ])
    const transfer = {
      items: [{ kind: 'file', webkitGetAsEntry: () => root }],
      files: [],
    } as unknown as DataTransfer
    const read = captureDroppedFiles(transfer)
    ;(transfer as unknown as { items: unknown[] }).items = []
    const result = await read()
    expect(result.kind).toBe('folder')
    expect(result.files.map((item) => item.relativePath)).toEqual([
      'project/empty.txt',
      'project/sub/config.json',
    ])
    expect(result.files[0]!.file.size).toBe(0)
  })
  it('不支持目录条目接口时仍可上传普通文件', async () => {
    const file = new File(['content'], 'file.txt')
    const read = captureDroppedFiles({ items: [], files: [file] } as unknown as DataTransfer)
    const result = await read()
    expect(result.files[0]).toEqual({ file, relativePath: 'file.txt' })
  })
})
