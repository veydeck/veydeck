/** 文件图标家族：按条目类型和最长后缀选择已确认的 v01 PNG。 */
import type { FsEntryDetail } from '@/api/interface/fs'

const assets = import.meta.glob<string>('../assets/file-icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})
const suffixGroups: Record<string, string[]> = {
  'file-text-v01': ['txt', 'text', 'rst'],
  'file-markdown-v01': ['md', 'markdown', 'mdown'],
  'file-pdf-v01': ['pdf'],
  'file-document-v01': ['doc', 'docx', 'odt', 'rtf'],
  'file-spreadsheet-v01': ['xls', 'xlsx', 'ods', 'csv', 'tsv'],
  'file-presentation-v01': ['ppt', 'pptx', 'odp'],
  'file-image-v01': [
    'jpg',
    'jpeg',
    'png',
    'webp',
    'gif',
    'bmp',
    'svg',
    'tif',
    'tiff',
    'avif',
    'heic',
  ],
  'file-audio-v01': ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'opus', 'aiff'],
  'file-video-v01': ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'mpeg', 'ts'],
  'file-archive-v01': [
    'zip',
    '7z',
    'rar',
    'tar',
    'tar.gz',
    'tar.xz',
    'tar.bz2',
    'tgz',
    'gz',
    'xz',
    'bz2',
    'zst',
  ],
  'file-disk-image-v01': ['iso', 'img', 'qcow2', 'vhd', 'vhdx', 'vmdk', 'dmg'],
  'file-executable-v01': ['exe', 'com', 'appimage'],
  'file-installer-v01': ['deb', 'rpm', 'apk', 'msi', 'pkg'],
  'file-vsp-v01': ['vsp'],
  'file-code-v01': [
    'js',
    'jsx',
    'ts',
    'tsx',
    'vue',
    'rs',
    'py',
    'go',
    'c',
    'h',
    'cpp',
    'hpp',
    'java',
    'rb',
    'php',
    'swift',
    'kt',
    'html',
    'css',
    'scss',
  ],
  'file-shell-v01': ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'],
  'file-config-v01': [
    'json',
    'yaml',
    'yml',
    'toml',
    'ini',
    'conf',
    'cfg',
    'xml',
    'env',
    'properties',
    'service',
  ],
  'file-log-v01': ['log', 'out'],
  'file-database-v01': ['db', 'sqlite', 'sqlite3', 'sql', 'mdb'],
  'file-certificate-v01': ['crt', 'cer', 'der', 'pem', 'p12', 'pfx'],
  'file-key-v01': ['key', 'pub', 'ppk'],
  'file-font-v01': ['ttf', 'otf', 'woff', 'woff2'],
}
const suffixes = Object.entries(suffixGroups)
  .flatMap(([icon, extensions]) => extensions.map((extension) => ({ extension, icon })))
  .sort((a, b) => b.extension.length - a.extension.length)

/** 返回经构建生成内容哈希的资源地址。 */
export function fileIconUrl(stem: string): string {
  return assets[`../assets/file-icons/${stem}.png`]!
}

/** 区分普通类型、未知链接和已解析链接；不为绘制图标发起请求。 */
export function resolveFileIcon(entry: FsEntryDetail): { icon: string; badge?: string } {
  const linked = entry.kind === 'symlink'
  const kind = linked ? entry.symlinkTargetKind : entry.kind
  const badge = linked
    ? entry.symlinkError
      ? 'badge-link-broken-v01'
      : 'badge-link-v01'
    : undefined
  if (!kind || kind === 'symlink') return { icon: 'link-generic-v01', badge }
  if (kind === 'directory') return { icon: 'folder-v01', badge }
  if (kind === 'other') return { icon: 'file-special-v01', badge }
  const name = (linked && entry.symlinkTarget ? entry.symlinkTarget : entry.name)
    .split('/')
    .pop()!
    .toLowerCase()
  // .ts 优先表达源码；其他视频后缀仍使用视频图标。
  const match = name.endsWith('.ts')
    ? 'file-code-v01'
    : suffixes.find(({ extension }) => name.endsWith('.' + extension) || name === '.' + extension)
        ?.icon
  return { icon: match || 'file-generic-v01', badge }
}
