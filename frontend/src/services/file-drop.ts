/** 浏览器文件拖入适配器：同步捕获拖拽引用，再异步遍历目录。 */
import type { FileUploadSelection } from './file-upload'

/** 读取目录的全部批次，保留顶层文件夹及相对路径。 */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
): Promise<FileUploadSelection['files']> {
  const relativePath = prefix + entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    )
    return [{ file, relativePath }]
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const files: FileUploadSelection['files'] = []
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (!batch.length) break
    for (const child of batch) files.push(...(await walkEntry(child, relativePath + '/')))
  }
  return files
}
/** 在 drop 事件仍有效时获取 FileSystemEntry 和 File 引用。 */
export function captureDroppedFiles(transfer: DataTransfer): () => Promise<FileUploadSelection> {
  const entries = Array.from(transfer.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() || null)
  const plain = Array.from(transfer.files)
  return async () => {
    const files =
      entries.length && entries.every(Boolean)
        ? (await Promise.all(entries.map((entry) => walkEntry(entry!, '')))).flat()
        : plain.map((file) => ({ file, relativePath: file.name }))
    return {
      kind: entries.some((entry) => entry?.isDirectory) ? 'folder' : 'files',
      displayName: entries.find((entry) => entry?.isDirectory)?.name || plain[0]?.name || '',
      files,
    }
  }
}
