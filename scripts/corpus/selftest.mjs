#!/usr/bin/env node
/**
 * 语料管线自检 —— 不需要网络、不需要真实语料，合成一小段 MIDI 验证全链路。
 *
 *   node scripts/corpus/selftest.mjs
 *   node scripts/corpus/selftest.mjs --real data/corpus/jrpg   # 额外跑一遍真实目录
 *
 * 断言覆盖：SMF 解析（含 running status / note on velocity=0）、调性估计、
 * 和弦识别、角色推断、质量闸门、画像聚合。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseMidi, summarize } from './midi-read.mjs'
import { extractFeatures, qualityGate, detectChord, estimateKey } from './features.mjs'
import { buildProfileFromDir } from './profile.mjs'

/* ------------------------------------------------------------------ */
/* 最小 SMF 写入器（仅测试用）                                          */
/* ------------------------------------------------------------------ */

const vlq = (value) => {
  const out = [value & 0x7f]
  let rest = value >>> 7
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  return out
}
const u16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]

function trackChunk(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick)
  const data = []
  let last = 0
  for (const event of sorted) {
    data.push(...vlq(event.tick - last), ...event.bytes)
    last = event.tick
  }
  data.push(...vlq(0), 0xff, 0x2f, 0x00)
  return [...Buffer.from('MTrk'), ...u32(data.length), ...data]
}

const meta = (type, bytes) => [0xff, type, ...vlq(bytes.length), ...bytes]

/** 构造 8 小节、4/4、120bpm、D 小调的 i-i-iv-iv-V-V-i-i */
function synthMidi() {
  const PPQ = 480
  const events = [
    [{ tick: 0, bytes: meta(0x51, [0x07, 0xa1, 0x20]) }, { tick: 0, bytes: meta(0x58, [4, 2, 24, 8]) }], // tempo + 拍号
  ]
  const chordTrack = []
  const bassTrack = []
  const drumTrack = []
  const chords = [
    [50, 53, 57], // Dm
    [50, 53, 57],
    [55, 58, 62], // Gm
    [55, 58, 62],
    [57, 61, 64], // A
    [57, 61, 64],
    [50, 53, 57], // Dm
    [50, 53, 57],
  ]
  const roots = [38, 38, 43, 43, 45, 45, 38, 38]

  chordTrack.push({ tick: 0, bytes: [0xc0, 0x00] }) // program: acoustic grand
  bassTrack.push({ tick: 0, bytes: [0xc1, 0x21] }) // program: electric bass (finger)
  for (let bar = 0; bar < 8; bar++) {
    const start = bar * 4 * PPQ
    for (const pitch of chords[bar]) {
      chordTrack.push({ tick: start, bytes: [0x90, pitch, 72] })
      chordTrack.push({ tick: start + 4 * PPQ, bytes: [0x80, pitch, 64] })
    }
    bassTrack.push({ tick: start, bytes: [0x91, roots[bar], 90] })
    bassTrack.push({ tick: start + 4 * PPQ, bytes: [0x81, roots[bar], 64] })
    for (const offset of [0, 2]) {
      drumTrack.push({ tick: start + offset * PPQ, bytes: [0x99, 36, 110] }) // kick
      drumTrack.push({ tick: start + offset * PPQ + 60, bytes: [0x89, 36, 64] })
    }
    for (const offset of [1, 3]) {
      drumTrack.push({ tick: start + offset * PPQ, bytes: [0x99, 38, 100] }) // snare
      drumTrack.push({ tick: start + offset * PPQ + 60, bytes: [0x89, 38, 64] })
    }
    // 反拍八分踩镲（顺便验证 running status 之外的正常路径）
    for (let eighth = 0; eighth < 8; eighth++) {
      const tick = start + eighth * (PPQ / 2)
      drumTrack.push({ tick, bytes: [0x99, 42, eighth % 2 ? 70 : 90] })
      drumTrack.push({ tick: tick + 40, bytes: [0x89, 42, 64] })
    }
  }
  events.push(chordTrack, bassTrack, drumTrack)
  const chunks = events.map(trackChunk).flat()
  return new Uint8Array([
    ...Buffer.from('MThd'),
    ...u32(6),
    ...u16(1), // format 1
    ...u16(events.length),
    ...u16(PPQ),
    ...chunks,
  ])
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[31m${detail}\x1b[0m` : ''}`)
  }
}

console.log('\nMIDI 语料管线自检\n')

/* --- 1. 解析 --- */
const bytes = synthMidi()
const parsed = parseMidi(bytes)
const summary = summarize(parsed)
check('解析格式 1', parsed.format === 1)
check('轨道数 4', parsed.tracks.length === 4, `实际 ${parsed.tracks.length}`)
check('拍号 4/4', summary.timeSignature.numerator === 4 && summary.timeSignature.denominator === 4)
check('速度 120 BPM', summary.bpm === 120, `实际 ${summary.bpm}`)
check('8 小节', Math.abs(summary.bars - 8) < 0.01, `实际 ${summary.bars}`)
check('音符数 64 + 64 踩镲', summary.noteCount === 8 * 3 + 8 + 8 * 4 + 8 * 8, `实际 ${summary.noteCount}`)
check('识别出鼓轨', summary.hasDrums === true)
check('音色号解析', summary.programs.includes(0) && summary.programs.includes(33), JSON.stringify(summary.programs))

/* --- 2. 调性与和弦 --- */
const features = extractFeatures(parsed, { bars: summary.bars })
check('调性 = D 小调', features.key.tonic === 2 && features.key.mode === 'minor', `实际 ${features.key.tonic}/${features.key.mode}（相关度 ${features.key.correlation}）`)

const dm = detectChord(new Map([[2, 1], [5, 1], [9, 1]]))
check('和弦识别 Dm', dm && dm.root === 2 && dm.suffix === 'm', dm ? `实际 ${dm.root}${dm.suffix}` : '未识别')
const gm = detectChord(new Map([[7, 1], [10, 1], [2, 1]]))
check('和弦识别 Gm', gm && gm.root === 7 && gm.suffix === 'm', gm ? `实际 ${gm.root}${gm.suffix}` : '未识别')
const aMajor = detectChord(new Map([[9, 1], [1, 1], [4, 1]]))
check('和弦识别 A', aMajor && aMajor.root === 9 && aMajor.suffix === '', aMajor ? `实际 ${aMajor.root}${aMajor.suffix}` : '未识别')

/* --- 3. 角色与纹理 --- */
const roles = features.texture.tracks.map((t) => t.role).sort()
check('角色推断含 drums/bass', roles.includes('drums') && roles.includes('bass'), JSON.stringify(roles))
check('鼓轨被排除在调性外', features.meta.drumNoteCount > 0 && features.meta.tonalNoteCount < features.meta.noteCount)
check('层数 = 2 个非鼓轨', features.texture.layerCount === 2, `实际 ${features.texture.layerCount}`)

/* --- 4. 质量闸门 --- */
const gate = qualityGate(parsed, features)
check('合成样本通过闸门', gate.ok === true, JSON.stringify(gate.reasons))
check('恒力度被打标', gate.tags.includes('robotVelocity'), JSON.stringify(gate.tags))

/* --- 5. 画像聚合 --- */
const dir = mkdtempSync(path.join(tmpdir(), 'aiab-corpus-'))
mkdirSync(path.join(dir, 'src'), { recursive: true })
for (let i = 0; i < 3; i++) writeFileSync(path.join(dir, 'src', `song-${i}.mid`), bytes)
const { profile } = buildProfileFromDir(dir, { style: 'selftest' })
check('画像统计 3 首', profile.corpus.files === 3, `实际 ${profile.corpus.files}`)
check('速度中位数 120', profile.tempo.median === 120, `实际 ${profile.tempo.median}`)
check('每小节和弦变化 0.5', Math.abs((profile.harmony.changePerBar?.median ?? 0) - 0.5) < 0.01, `实际 ${profile.harmony.changePerBar?.median}`)
check('复现性和弦进行 i>iv', profile.harmony.topProgressions.some(([p]) => p === 'i>iv'), JSON.stringify(profile.harmony.topProgressions.slice(0, 4)))
check('调式分布 0% 大调', profile.key.majorShare === 0, `实际 ${profile.key.majorShare}`)
rmSync(dir, { recursive: true, force: true })

/* --- 6. 损坏输入 --- */
let threw = false
try {
  parseMidi(new Uint8Array([1, 2, 3, 4]))
} catch {
  threw = true
}
check('损坏文件抛错', threw)

/* --- 7. 可选：真实目录 --- */
const realIndex = process.argv.indexOf('--real')
if (realIndex >= 0) {
  const realDir = process.argv[realIndex + 1]
  console.log(`\n真实语料：${realDir}`)
  const { profile: realProfile, accepted, rejected } = buildProfileFromDir(realDir, { style: 'real', log: console.log })
  check('真实语料能构建画像', accepted.length > 0, `${accepted.length} 通过 / ${rejected.length} 丢弃`)
  console.log(`    速度中位数 ${realProfile.tempo?.median} BPM，密度 ${realProfile.rhythm.densityPerBar?.median} 音/小节，调内率 ${(realProfile.harmony.diatonicRate?.median ?? 0).toFixed(2)}`)
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} 通过，${failed} 失败\x1b[0m\n`)
process.exit(failed ? 1 : 0)
