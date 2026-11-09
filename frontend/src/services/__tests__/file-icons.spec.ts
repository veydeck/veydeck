import { describe, expect, it } from 'vitest'
import type { FsEntryDetail } from '@/api/interface/fs'
import { fileIconUrl, resolveFileIcon } from '../file-icons'

/** 构造图标选择所需的文件事实。 */
function entry(name: string, fields: Partial<FsEntryDetail> = {}): FsEntryDetail {
  return { name, kind: 'file', ...fields } as FsEntryDetail
}

describe('文件图标家族', () => {
  it.each([
    'root',
    'home',
    'etc',
    'var',
    'usr',
    'bin',
    'sbin',
    'lib',
    'lib64',
    'boot',
    'dev',
    'proc',
    'sys',
    'run',
    'tmp',
    'mnt',
    'media',
    'opt',
    'srv',
  ])('顶层 /%s 使用专属图标，其他同名目录不受影响', (name) => {
    const icon = `folder-linux-${name}-v01`
    expect(resolveFileIcon(entry(name, { path: '/' + name, kind: 'directory' })).icon).toBe(icon)
    expect(fileIconUrl(icon)).toMatch(/\.png/)
    expect(resolveFileIcon(entry(name, { path: '/data/' + name, kind: 'directory' })).icon).toBe(
      'folder-v01',
    )
    expect(resolveFileIcon(entry(name, { path: '/' + name, kind: 'file' })).icon).toBe(
      'file-generic-v01',
    )
  })

  it('顶层链接仅按接口目标类型选择图标，不猜测目录类型', () => {
    const link = entry('bin', { path: '/bin', kind: 'symlink' })
    expect(resolveFileIcon(link)).toEqual({ icon: 'link-generic-v01', badge: 'badge-link-v01' })
    expect(resolveFileIcon({ ...link, symlinkTargetKind: 'directory' })).toEqual({
      icon: 'folder-link-v01',
      badge: 'badge-link-v01',
    })
    expect(resolveFileIcon({ ...link, symlinkTargetKind: 'file' }).icon).toBe('link-generic-v01')
    expect(resolveFileIcon({ ...link, symlinkError: 'FILE_NOT_FOUND' })).toEqual({
      icon: 'link-generic-v01',
      badge: 'badge-link-broken-v01',
    })
    expect(resolveFileIcon(entry('bin', { path: '/data/bin', kind: 'symlink' })).icon).toBe(
      'link-generic-v01',
    )
  })

  it.each([
    ['SCRIPT.SH', 'file-shell-v01'],
    ['capture.PCAP', 'file-capture-v01'],
    ['capture.pcapng', 'file-capture-v01'],
    ['capture.cap', 'file-capture-v01'],
    ['ubuntu.torrent', 'file-torrent-v01'],
    ['book.epub', 'file-ebook-v01'],
    ['book.mobi', 'file-ebook-v01'],
    ['book.azw3', 'file-ebook-v01'],
    ['backup.tar.gz', 'file-archive-v01'],
    ['.env', 'file-config-v01'],
    ['hello.ts', 'file-code-v01'],
    ['movie.mkv', 'file-video-v01'],
    ['suite.vsp', 'file-vsp-v01'],
    ['unknown.xyz', 'file-generic-v01'],
    ['README', 'file-generic-v01'],
  ])('按后缀识别 %s，并提供存在的 PNG', (name, icon) => {
    expect(resolveFileIcon(entry(name)).icon).toBe(icon)
    expect(fileIconUrl(icon)).toMatch(/\.png/)
  })

  it('目录链接使用专属图标，文件链接优先匹配类型，失效链接使用断链角标', () => {
    expect(resolveFileIcon(entry('folder.sh', { kind: 'directory' })).icon).toBe('folder-v01')
    expect(resolveFileIcon(entry('device', { kind: 'other' })).icon).toBe('file-special-v01')
    expect(resolveFileIcon(entry('bin', { kind: 'symlink' }))).toEqual({
      icon: 'link-generic-v01',
      badge: 'badge-link-v01',
    })
    expect(
      resolveFileIcon(entry('bin', { kind: 'symlink', symlinkTargetKind: 'directory' })),
    ).toEqual({
      icon: 'folder-link-v01',
      badge: 'badge-link-v01',
    })
    expect(fileIconUrl('folder-link-v01')).toMatch(/\.png/)
    expect(
      resolveFileIcon(
        entry('script-alias', {
          kind: 'symlink',
          symlinkTarget: '../scripts/start.SH',
          symlinkTargetKind: 'file',
        }),
      ),
    ).toEqual({ icon: 'file-shell-v01', badge: 'badge-link-v01' })
    expect(
      resolveFileIcon(
        entry('folder-link', {
          kind: 'symlink',
          symlinkTargetKind: 'directory',
          symlinkError: 'FILE_NOT_FOUND',
        }),
      ),
    ).toEqual({ icon: 'link-generic-v01', badge: 'badge-link-broken-v01' })
    expect(
      resolveFileIcon(
        entry('missing', {
          kind: 'symlink',
          symlinkError: 'FS_NOT_FOUND' as FsEntryDetail['symlinkError'],
        }),
      ).badge,
    ).toBe('badge-link-broken-v01')
  })

  it.each([
    ['alias', '../scripts/start.SH', 'file-shell-v01'],
    ['alias.txt', '/data/photo.PNG', 'file-image-v01'],
    ['alias', '/backup/data.tar.gz', 'file-archive-v01'],
    ['alias.sh', '/data/unknown.xyz', 'link-generic-v01'],
    ['alias.sh', '/data/README', 'link-generic-v01'],
    ['alias', undefined, 'link-generic-v01'],
    ['alias.sh', undefined, 'file-shell-v01'],
  ])('文件链接 %s 指向 %s 时正确匹配或回退，始终保留链接角标', (name, target, icon) => {
    const appearance = resolveFileIcon(
      entry(name, { kind: 'symlink', symlinkTargetKind: 'file', symlinkTarget: target }),
    )
    expect(appearance).toEqual({ icon, badge: 'badge-link-v01' })
  })
})
