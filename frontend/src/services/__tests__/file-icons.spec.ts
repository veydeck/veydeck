import { describe, expect, it } from 'vitest'
import type { FsEntryDetail } from '@/api/interface/fs'
import { fileIconUrl, resolveFileIcon } from '../file-icons'

/** 构造图标选择所需的文件事实。 */
function entry(name: string, fields: Partial<FsEntryDetail> = {}): FsEntryDetail {
  return { name, kind: 'file', ...fields } as FsEntryDetail
}

describe('文件图标家族', () => {
  it.each([
    ['SCRIPT.SH', 'file-shell-v01'],
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
