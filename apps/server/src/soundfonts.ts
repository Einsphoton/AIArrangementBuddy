/**
 * 音色库（SoundFont）管理：列表 / 下载。
 * 源表与 scripts/fetch-soundfonts.mjs 保持一致（独立复制，不依赖脚本）。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { soundfontsDir } from './config.js'
import { errorMessage, formatBytes } from './util.js'

export interface SoundfontSource {
  id: string
  name: string
  label: string
  url: string
  size?: number
  license: string
  default?: boolean
}

export interface SoundfontFileInfo {
  name: string
  url: string
  size: number
  license?: string
  sourceId?: string
}

export const SOUNDFONT_SOURCES: SoundfontSource[] = [
  {
    id: 'musescore-general',
    name: 'MuseScore_General.sf3',
    label: 'MuseScore General（MIT，全能 GM，推荐）',
    url: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3',
    size: 39_900_972,
    license: 'MIT',
    default: true,
  },
  {
    id: 'musescore-general-sf2',
    name: 'MuseScore_General.sf2',
    label: 'MuseScore General（SF2 未压缩版，兼容性最好）',
    url: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf2',
    license: 'MIT',
  },
  {
    id: 'generaluser-gs',
    name: 'GeneralUser_GS.sf2',
    label: 'GeneralUser GS（轻量，音色均衡）',
    url: 'https://raw.githubusercontent.com/FluidSynth/fluidsynth-midi/master/GeneralUserGS.sf2',
    license: 'GeneralUser GS License (free)',
  },
]

const SOUNDFONT_EXTENSIONS = ['.sf2', '.sf3', '.dls']

/** 扫描 DATA_DIR/soundfonts 下的音色库文件 */
export function listSoundfontFiles(): SoundfontFileInfo[] {
  if (!existsSync(soundfontsDir)) return []
  const files: SoundfontFileInfo[] = []
  for (const name of readdirSync(soundfontsDir)) {
    if (!SOUNDFONT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) continue
    try {
      const stat = statSync(path.join(soundfontsDir, name))
      if (!stat.isFile()) continue
      const source = SOUNDFONT_SOURCES.find((item) => item.name === name)
      files.push({
        name,
        url: `/soundfonts/${encodeURIComponent(name)}`,
        size: stat.size,
        license: source?.license,
        sourceId: source?.id,
      })
    } catch {
      /* ignore */
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

export function findSource(id: string): SoundfontSource | undefined {
  return SOUNDFONT_SOURCES.find((source) => source.id === id || source.name === id || source.name.replace(/\.[^.]+$/, '') === id)
}

/** 下载音色库到 DATA_DIR/soundfonts（已存在则直接返回） */
export async function downloadSoundfont(
  source: SoundfontSource,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string; url?: string; size?: number }> {
  mkdirSync(soundfontsDir, { recursive: true })
  const destination = path.join(soundfontsDir, source.name)
  if (existsSync(destination) && statSync(destination).size > 1024) {
    return {
      ok: true,
      message: `音色库已存在：${source.name}（${formatBytes(statSync(destination).size)}）`,
      url: `/soundfonts/${encodeURIComponent(source.name)}`,
      size: statSync(destination).size,
    }
  }
  const temp = `${destination}.part`
  try {
    const response = await fetch(source.url, { redirect: 'follow', signal })
    if (!response.ok || !response.body) {
      return { ok: false, message: `下载失败：HTTP ${response.status}（${source.url}）` }
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp))
    renameSync(temp, destination)
    const size = statSync(destination).size
    if (size < 1024) {
      unlinkSync(destination)
      return { ok: false, message: '下载文件不完整（<1KB），已删除，请重试或手动下载' }
    }
    return {
      ok: true,
      message: `已下载 ${source.name}（${formatBytes(size)}）`,
      url: `/soundfonts/${encodeURIComponent(source.name)}`,
      size,
    }
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      /* ignore */
    }
    return { ok: false, message: `下载失败：${errorMessage(error)}` }
  }
}

export function bundledSoundfonts(): boolean {
  return listSoundfontFiles().length > 0
}
