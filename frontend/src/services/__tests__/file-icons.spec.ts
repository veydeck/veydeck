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

  it('顶层目录链接保留角标，尊重已知目标类型和失效状态', () => {
    const link = entry('bin', { path: '/bin', kind: 'symlink' })
    expect(resolveFileIcon(link)).toEqual({ icon: 'folder-linux-bin-v01', badge: 'badge-link-v01' })
    expect(resolveFileIcon({ ...link, symlinkTargetKind: 'file' }).icon).toBe('file-generic-v01')
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

  it('条目类型优先于名称，链接保留独立角标', () => {
    expect(resolveFileIcon(entry('folder.sh', { kind: 'directory' })).icon).toBe('folder-v01')
    expect(resolveFileIcon(entry('device', { kind: 'other' })).icon).toBe('file-special-v01')
    expect(resolveFileIcon(entry('bin', { kind: 'symlink' }))).toEqual({
      icon: 'link-generic-v01',
      badge: 'badge-link-v01',
    })
    expect(
      resolveFileIcon(entry('bin', { kind: 'symlink', symlinkTargetKind: 'directory' })),
    ).toEqual({
      icon: 'folder-v01',
      badge: 'badge-link-v01',
    })
    expect(
      resolveFileIcon(
        entry('missing', {
          kind: 'symlink',
          symlinkError: 'FS_NOT_FOUND' as FsEntryDetail['symlinkError'],
        }),
      ).badge,
    ).toBe('badge-link-broken-v01')
  })
})
