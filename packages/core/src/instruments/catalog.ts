/**
 * 内置乐器目录。
 *
 * 本文件由「核心音乐引擎」维护，覆盖：
 *   古典/管弦 · 摇滚/流行 · 电子 · 世界/色彩 · 鼓组，共 32 件乐器。
 *
 * 约定：
 * - id 采用 `family.instrument` 形式，稳定不变（会写进工程文件）；
 * - gmProgram 为 GM 标准程序号（0-based，0-127），鼓组固定 program 0 且 isDrumKit=true；
 * - emotions[0] 为该乐器默认情绪；
 * - synth 配方由音频引擎解释为 Tone.js 图，没有音色库时也能出声（分层振荡器 + 滤波包络 + FX 发送）；
 * - 每个乐器至少 4 种情绪，情绪对应真实演奏法（pizzicato / tremolo / palmMute / 弱音器 …）。
 */
import type { InstrumentDefinition, LayerSpec, SynthPatch } from './types.js'
import { emotion, env, layer, patch } from './helpers.js'

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function inst(def: InstrumentDefinition): InstrumentDefinition {
  return def
}

/** 常用滤波包络：音头打开、快速回落（拨弦/钢琴/吉他类） */
function pluckFilter(cutoff: number, q = 1.1, amount = 0.45): LayerSpec['filter'] {
  return { type: 'lowpass', frequency: cutoff, Q: q, envAmount: amount, envelope: env(0.004, 0.9, 0.05, 0.35) }
}

/** 慢速滤波扫频（铺底/铜管） */
function swellFilter(cutoff: number, attack = 0.5, q = 0.7): LayerSpec['filter'] {
  return { type: 'lowpass', frequency: cutoff, Q: q, envAmount: 0.35, envelope: env(attack, 1.4, 0.45, 1.2) }
}

/** 弦乐/人声共用：分层锯齿 + 弱颤音 */
function bowedPatch(layers: LayerSpec[], opts: Partial<SynthPatch> = {}): SynthPatch {
  return patch(layers, { velocitySensitivity: 0.42, polyphony: 24, ...opts })
}

/* ------------------------------------------------------------------ */
/* 键盘                                                                */
/* ------------------------------------------------------------------ */

const PIANO: InstrumentDefinition = inst({
  id: 'piano.grand',
  name: '三角钢琴',
  nameEn: 'Grand Piano',
  family: 'classical',
  category: '键盘',
  engine: 'soundfont',
  gmProgram: 0,
  isDrumKit: false,
  range: { min: 21, max: 108 },
  smartKinds: ['chords', 'melody', 'arp', 'bass', 'riff'],
  synth: patch(
    [
      layer('fatsawtooth', {
        gain: 0.3,
        detune: 5,
        envelope: env(0.003, 2.4, 0.0, 0.85),
        filter: { type: 'lowpass', frequency: 3400, Q: 0.6, envAmount: 0.4, envelope: env(0.003, 1.8, 0.0, 0.5) },
      }),
      layer('sine', { octave: 1, gain: 0.16, envelope: env(0.002, 1.6, 0.0, 0.7), vibrato: { rate: 4.5, depth: 3 } }),
      layer('triangle', { octave: -1, gain: 0.2, envelope: env(0.006, 3.0, 0.0, 0.95) }),
    ],
    { velocitySensitivity: 0.78, polyphony: 32, fx: { reverb: 0.22, delay: 0.04, chorus: 0.04, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '低通柔化、长尾踏板，适合抒情段落', '#d4a95c', { brightness: 0.42, warmth: 0.72, release: 0.5, reverb: 0.28, articulation: 'sustain' }),
    emotion('clear', '清澈', 'Clear', '明亮通透，颗粒清晰，适合流行伴奏', '#f0d9a8', { brightness: 0.72, warmth: 0.35, reverb: 0.2, articulation: 'sustain' }),
    emotion('melancholy', '忧郁', 'Melancholy', '缓慢起音与长尾，适合独白式分解', '#7f9cf5', { brightness: 0.38, attack: 0.42, release: 0.62, reverb: 0.36, articulation: 'legato' }),
    emotion('dramatic', '激昂', 'Dramatic', '力度反差大，冲击感强', '#e0562a', { brightness: 0.78, drive: 0.12, reverb: 0.24, velocityCurve: 0.35, articulation: 'marcato' }),
    emotion('staccato', '断奏', 'Staccato', '短促颗粒，适合律动型伴奏', '#3ddbd9', { release: 0.12, sustain: 0.2, brightness: 0.62, articulation: 'staccato' }),
  ],
  previewNotes: [0, 4, 7, 12],
  description: '最通用的声部，既能铺底也能独奏',
  icon: '🎹',
  styles: ['classical', 'pop', 'cinematic', 'jazz'],
})

const PIANO_ELECTRIC: InstrumentDefinition = inst({
  id: 'piano.electric',
  name: '电钢琴',
  nameEn: 'Electric Piano',
  family: 'rock',
  category: '键盘',
  engine: 'soundfont',
  gmProgram: 4,
  isDrumKit: false,
  range: { min: 28, max: 100 },
  smartKinds: ['chords', 'melody', 'arp', 'pad'],
  synth: patch(
    [
      layer('fm', {
        gain: 0.34,
        fm: { harmonicity: 2.01, modulationIndex: 7 },
        envelope: env(0.004, 1.6, 0.18, 0.55),
        filter: { type: 'lowpass', frequency: 3000, Q: 0.8, envAmount: 0.3, envelope: env(0.004, 1.2, 0.2, 0.4) },
      }),
      layer('sine', { octave: 1, gain: 0.16, envelope: env(0.003, 1.1, 0.12, 0.4), vibrato: { rate: 5.2, depth: 6 } }),
      layer('triangle', { octave: -1, gain: 0.18, envelope: env(0.006, 1.8, 0.1, 0.6) }),
    ],
    { velocitySensitivity: 0.7, polyphony: 24, fx: { reverb: 0.24, delay: 0.06, chorus: 0.2, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('tine', '琴片', 'Tine', '经典电钢的金属琴片音头', '#3ddbd9', { brightness: 0.58, warmth: 0.5, chorus: 0.18, articulation: 'pluck' }),
    emotion('warm', '温暖', 'Warm', '柔化高频，和弦铺底', '#d4a95c', { brightness: 0.4, warmth: 0.75, attack: 0.18, release: 0.55, chorus: 0.25 }),
    emotion('bell', '铃音', 'Bell', '明亮铃铛感，适合分解', '#f0d9a8', { brightness: 0.8, warmth: 0.3, delay: 0.18, articulation: 'pluck' }),
    emotion('soft', '柔和', 'Soft', '极弱力度、绵长尾音', '#7f9cf5', { brightness: 0.34, attack: 0.3, release: 0.68, reverb: 0.42 }),
    emotion('wah', '哇音', 'Wah', '带调制感的放克电钢', '#a3b86c', { brightness: 0.68, vibrato: 0.24, vibratoRate: 5.8, articulation: 'sustain' }),
  ],
  previewNotes: [0, 4, 7, 11],
  description: '爵士/流行/电子通用的键盘声部',
  icon: '🎹',
  styles: ['jazz', 'pop', 'electronic', 'folk'],
})

/* ------------------------------------------------------------------ */
/* 弦乐                                                                */
/* ------------------------------------------------------------------ */

const STRINGS: InstrumentDefinition = inst({
  id: 'strings.ensemble',
  name: '弦乐群',
  nameEn: 'String Ensemble',
  family: 'classical',
  category: '弦乐',
  engine: 'soundfont',
  gmProgram: 48,
  isDrumKit: false,
  range: { min: 36, max: 96 },
  smartKinds: ['pad', 'chords', 'counter', 'melody', 'arp'],
  synth: bowedPatch(
    [
      layer('fatsawtooth', { gain: 0.28, detune: 9, envelope: env(0.26, 0.6, 0.86, 0.95), filter: swellFilter(2200, 0.35) }),
      layer('sawtooth', { octave: 1, gain: 0.13, detune: -7, envelope: env(0.34, 0.5, 0.82, 1.05) }),
      layer('triangle', { octave: -1, gain: 0.17, envelope: env(0.4, 0.5, 0.85, 1.1) }),
    ],
    { fx: { reverb: 0.36, delay: 0.05, chorus: 0.16, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('soft', '柔和', 'Soft', '蓬松的弱奏，铺底首选', '#d4a95c', { brightness: 0.38, attack: 0.42, release: 0.6, vibrato: 0.06, reverb: 0.36, articulation: 'sustain' }),
    emotion('bright', '明亮', 'Bright', '清晰有光泽的群奏', '#f0d9a8', { brightness: 0.7, attack: 0.2, release: 0.42, vibrato: 0.1, articulation: 'legato' }),
    emotion('dramatic', '戏剧性', 'Dramatic', '强弓、宽颤音', '#e0562a', { brightness: 0.6, drive: 0.08, vibrato: 0.28, vibratoRate: 5.8, reverb: 0.32, articulation: 'marcato' }),
    emotion('pizzicato', '拨奏', 'Pizzicato', '短促拨弦，跳脱灵动', '#3ddbd9', { brightness: 0.6, attack: 0.02, release: 0.1, sustain: 0.15, reverb: 0.24, articulation: 'pizzicato' }),
    emotion('tremolo', '震音', 'Tremolo', '弓弦快速反复，紧张感', '#f472b6', { brightness: 0.72, warmth: 0.32, vibrato: 0.4, vibratoRate: 8.5, articulation: 'tremolo' }),
    emotion('epic', '宏大', 'Epic', '宽立体声、长混响', '#7f9cf5', { brightness: 0.58, warmth: 0.6, stereoWidth: 0.9, reverb: 0.48, release: 0.7, articulation: 'swell' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '管弦乐的骨架，能铺底也能推情绪',
  icon: '🎻',
  styles: ['classical', 'cinematic', 'pop'],
})

const VIOLIN: InstrumentDefinition = inst({
  id: 'strings.violin',
  name: '独奏小提琴',
  nameEn: 'Solo Violin',
  family: 'classical',
  category: '弦乐',
  engine: 'soundfont',
  gmProgram: 40,
  isDrumKit: false,
  range: { min: 55, max: 103 },
  smartKinds: ['melody', 'counter', 'pad'],
  synth: bowedPatch(
    [
      layer('sawtooth', {
        gain: 0.32,
        detune: 3,
        envelope: env(0.16, 0.4, 0.88, 0.6),
        filter: { type: 'lowpass', frequency: 3800, Q: 0.9, envAmount: 0.22, envelope: env(0.2, 0.8, 0.6, 0.5) },
        vibrato: { rate: 5.6, depth: 12 },
      }),
      layer('fatsawtooth', { octave: 1, gain: 0.12, detune: -5, envelope: env(0.22, 0.4, 0.8, 0.7) }),
    ],
    { monophonic: true, glide: 0.035, velocitySensitivity: 0.55, fx: { reverb: 0.32, delay: 0.06, chorus: 0.08, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('solo', '独奏', 'Solo', '歌唱性的独奏音色，突出旋律', '#d4a95c', { brightness: 0.6, vibrato: 0.3, vibratoRate: 5.6, attack: 0.18, articulation: 'legato' }),
    emotion('expressive', '抒情', 'Expressive', '宽颤音与长气息的抒情句', '#7f9cf5', { brightness: 0.48, vibrato: 0.42, vibratoRate: 5.2, attack: 0.3, release: 0.62, articulation: 'sustain' }),
    emotion('pizzicato', '拨奏', 'Pizzicato', '短促拨弦，谐谑段落', '#3ddbd9', { brightness: 0.66, attack: 0.01, release: 0.08, sustain: 0.1, articulation: 'pizzicato' }),
    emotion('tremolo', '震音', 'Tremolo', '快速震音制造张力', '#f472b6', { brightness: 0.74, vibrato: 0.5, vibratoRate: 9, attack: 0.08, articulation: 'tremolo' }),
    emotion('spiccato', '跳弓', 'Spiccato', '轻巧的跳弓颗粒', '#a3b86c', { brightness: 0.68, release: 0.14, sustain: 0.2, articulation: 'staccato' }),
  ],
  previewNotes: [0, 7, 12, 19],
  description: '影视与古典的旋律王牌，音色有穿透力',
  icon: '🎻',
  styles: ['classical', 'cinematic', 'folk'],
})

const CELLO: InstrumentDefinition = inst({
  id: 'strings.cello',
  name: '大提琴',
  nameEn: 'Cello',
  family: 'classical',
  category: '弦乐',
  engine: 'soundfont',
  gmProgram: 42,
  isDrumKit: false,
  range: { min: 36, max: 76 },
  smartKinds: ['bass', 'counter', 'melody', 'pad'],
  synth: bowedPatch(
    [
      layer('sawtooth', {
        gain: 0.34,
        detune: 4,
        envelope: env(0.18, 0.5, 0.86, 0.7),
        filter: { type: 'lowpass', frequency: 1500, Q: 0.9, envAmount: 0.28, envelope: env(0.22, 0.9, 0.55, 0.6) },
        vibrato: { rate: 5.1, depth: 10 },
      }),
      layer('triangle', { octave: -1, gain: 0.2, envelope: env(0.2, 0.6, 0.82, 0.8) }),
    ],
    { monophonic: true, glide: 0.04, velocitySensitivity: 0.5, fx: { reverb: 0.34, delay: 0.04, chorus: 0.1, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '厚实温暖的歌唱性低音', '#d4a95c', { brightness: 0.42, warmth: 0.78, vibrato: 0.24, attack: 0.2, articulation: 'legato' }),
    emotion('deep', '深沉', 'Deep', '低音区共鸣、缓慢起音', '#7f9cf5', { brightness: 0.3, warmth: 0.85, attack: 0.34, release: 0.7, articulation: 'sustain' }),
    emotion('pizzicato', '拨奏', 'Pizzicato', '短促拨奏的低音律动', '#3ddbd9', { brightness: 0.55, attack: 0.01, release: 0.1, sustain: 0.12, articulation: 'pizzicato' }),
    emotion('marcato', '强奏', 'Marcato', '有力的重音运弓', '#e0562a', { brightness: 0.64, drive: 0.1, attack: 0.06, velocityCurve: 0.4, articulation: 'marcato' }),
    emotion('tremolo', '震音', 'Tremolo', '低音震音，悬疑氛围', '#f472b6', { brightness: 0.5, vibrato: 0.45, vibratoRate: 8, attack: 0.1, articulation: 'tremolo' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '支撑和声的低音弦乐，也能唱主旋律',
  icon: '🎻',
  styles: ['classical', 'cinematic', 'folk'],
})

const DOUBLE_BASS: InstrumentDefinition = inst({
  id: 'strings.doublebass',
  name: '低音提琴',
  nameEn: 'Double Bass',
  family: 'classical',
  category: '弦乐',
  engine: 'soundfont',
  gmProgram: 43,
  isDrumKit: false,
  range: { min: 24, max: 60 },
  smartKinds: ['bass', 'counter'],
  synth: bowedPatch(
    [
      layer('triangle', { octave: -1, gain: 0.42, envelope: env(0.05, 0.8, 0.4, 0.4), filter: { type: 'lowpass', frequency: 900, Q: 1.2, envAmount: 0.3, envelope: env(0.02, 0.7, 0.2, 0.3) } }),
      layer('sine', { octave: -2, gain: 0.3, envelope: env(0.02, 0.9, 0.5, 0.4) }),
      layer('sawtooth', { octave: -1, gain: 0.08, detune: 6, envelope: env(0.08, 0.6, 0.3, 0.35) }),
    ],
    { monophonic: true, glide: 0.05, velocitySensitivity: 0.6, fx: { reverb: 0.2, delay: 0, chorus: 0, distortion: 0, busLowpass: 2200 } },
  ),
  emotions: [
    emotion('pizzicato', '拨奏', 'Pizzicato', '爵士/古典通用的拨奏低音', '#a3b86c', { brightness: 0.5, attack: 0.02, release: 0.18, sustain: 0.2, articulation: 'pizzicato' }),
    emotion('arco', '弓奏', 'Arco', '绵长的弓奏低音线', '#d4a95c', { brightness: 0.35, warmth: 0.8, attack: 0.26, release: 0.55, articulation: 'legato' }),
    emotion('deep', '低沉', 'Deep', '极低频铺垫，影视感', '#7f9cf5', { brightness: 0.24, warmth: 0.9, attack: 0.3, release: 0.66, articulation: 'sustain' }),
    emotion('swing', '摇摆', 'Swing', '走路贝斯的弹性音头', '#a97bd6', { brightness: 0.52, attack: 0.04, release: 0.24, sustain: 0.35, articulation: 'marcato' }),
  ],
  previewNotes: [0, 7, 12, 5],
  description: '管弦与爵士的根音支柱',
  icon: '🎻',
  styles: ['classical', 'jazz', 'cinematic', 'folk'],
})

/* ------------------------------------------------------------------ */
/* 木管 / 铜管                                                          */
/* ------------------------------------------------------------------ */

const FLUTE: InstrumentDefinition = inst({
  id: 'woodwinds.flute',
  name: '长笛',
  nameEn: 'Flute',
  family: 'classical',
  category: '木管',
  engine: 'soundfont',
  gmProgram: 73,
  isDrumKit: false,
  range: { min: 60, max: 96 },
  smartKinds: ['melody', 'counter', 'pad'],
  synth: patch(
    [
      layer('sine', {
        gain: 0.42,
        envelope: env(0.09, 0.3, 0.85, 0.35),
        filter: { type: 'lowpass', frequency: 5200, Q: 0.5, envAmount: 0.18, envelope: env(0.12, 0.5, 0.6, 0.4) },
        vibrato: { rate: 5.4, depth: 11 },
      }),
      layer('triangle', { octave: 1, gain: 0.1, envelope: env(0.14, 0.3, 0.7, 0.4) }),
      layer('noise', { gain: 0.035, envelope: env(0.06, 0.22, 0.5, 0.25), filter: { type: 'bandpass', frequency: 4200, Q: 1.4, envAmount: 0 } }),
    ],
    { monophonic: true, glide: 0.02, velocitySensitivity: 0.45, fx: { reverb: 0.3, delay: 0.08, chorus: 0.04, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('airy', '气息', 'Airy', '带气声的柔和长笛', '#d4a95c', { brightness: 0.5, warmth: 0.55, vibrato: 0.2, attack: 0.16, release: 0.42, articulation: 'legato' }),
    emotion('bright', '明亮', 'Bright', '通透清脆的高音区', '#f0d9a8', { brightness: 0.78, warmth: 0.28, vibrato: 0.14, articulation: 'sustain' }),
    emotion('soft', '轻弱', 'Soft', '极弱奏，适合前奏', '#7f9cf5', { brightness: 0.36, attack: 0.28, release: 0.6, reverb: 0.44, articulation: 'swell' }),
    emotion('staccato', '断奏', 'Staccato', '轻巧的吐音颗粒', '#3ddbd9', { brightness: 0.68, release: 0.1, sustain: 0.18, articulation: 'staccato' }),
    emotion('flutter', '花舌', 'Flutter', '花舌与颤音制造戏剧感', '#f472b6', { brightness: 0.7, vibrato: 0.5, vibratoRate: 11, articulation: 'tremolo' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '清澈的旋律木管，对位与装饰都合适',
  icon: '🪈',
  styles: ['classical', 'cinematic', 'folk'],
})

const CLARINET: InstrumentDefinition = inst({
  id: 'woodwinds.clarinet',
  name: '单簧管',
  nameEn: 'Clarinet',
  family: 'classical',
  category: '木管',
  engine: 'soundfont',
  gmProgram: 71,
  isDrumKit: false,
  range: { min: 50, max: 88 },
  smartKinds: ['melody', 'counter', 'pad'],
  synth: patch(
    [
      layer('square', {
        gain: 0.3,
        envelope: env(0.07, 0.35, 0.82, 0.3),
        filter: { type: 'lowpass', frequency: 2200, Q: 1.2, envAmount: 0.22, envelope: env(0.1, 0.5, 0.55, 0.35) },
        vibrato: { rate: 4.8, depth: 7 },
      }),
      layer('triangle', { octave: -1, gain: 0.16, envelope: env(0.09, 0.4, 0.78, 0.35) }),
    ],
    { monophonic: true, glide: 0.025, velocitySensitivity: 0.5, fx: { reverb: 0.26, delay: 0.05, chorus: 0.05, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '圆润的木质音色', '#d4a95c', { brightness: 0.42, warmth: 0.72, vibrato: 0.16, attack: 0.12, articulation: 'legato' }),
    emotion('dark', '低音区', 'Chalumeau', '低音区浑厚，适合内声部', '#7f9cf5', { brightness: 0.3, warmth: 0.85, attack: 0.2, release: 0.5, articulation: 'sustain' }),
    emotion('bright', '明亮', 'Bright', '高音区明亮穿透', '#f0d9a8', { brightness: 0.74, warmth: 0.35, vibrato: 0.12, articulation: 'sustain' }),
    emotion('staccato', '断奏', 'Staccato', '短促跳跃的断奏', '#3ddbd9', { brightness: 0.6, release: 0.1, sustain: 0.2, articulation: 'staccato' }),
  ],
  previewNotes: [0, 7, 12, 15],
  description: '木管组的中坚，音色圆润有表现力',
  icon: '🎷',
  styles: ['classical', 'jazz', 'cinematic', 'folk'],
})

const OBOE: InstrumentDefinition = inst({
  id: 'woodwinds.oboe',
  name: '双簧管',
  nameEn: 'Oboe',
  family: 'classical',
  category: '木管',
  engine: 'soundfont',
  gmProgram: 68,
  isDrumKit: false,
  range: { min: 58, max: 91 },
  smartKinds: ['melody', 'counter'],
  synth: patch(
    [
      layer('pulse', {
        gain: 0.3,
        pulseWidth: 0.38,
        envelope: env(0.06, 0.3, 0.8, 0.28),
        filter: { type: 'lowpass', frequency: 2600, Q: 1.5, envAmount: 0.25, envelope: env(0.08, 0.4, 0.5, 0.3) },
        vibrato: { rate: 5.2, depth: 9 },
      }),
      layer('sawtooth', { octave: 1, gain: 0.08, envelope: env(0.08, 0.3, 0.7, 0.3) }),
    ],
    { monophonic: true, glide: 0.02, velocitySensitivity: 0.5, fx: { reverb: 0.28, delay: 0.05, chorus: 0, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('reedy', '簧片', 'Reedy', '标志性的双簧鼻音', '#d4a95c', { brightness: 0.58, warmth: 0.5, vibrato: 0.2, attack: 0.08, articulation: 'legato' }),
    emotion('sweet', '甜美', 'Sweet', '柔化的田园旋律', '#a3b86c', { brightness: 0.48, warmth: 0.62, vibrato: 0.14, attack: 0.16, release: 0.45, articulation: 'sustain' }),
    emotion('plaintive', '哀怨', 'Plaintive', '长气息的叹息句', '#7f9cf5', { brightness: 0.36, attack: 0.3, release: 0.66, vibrato: 0.3, reverb: 0.4, articulation: 'legato' }),
    emotion('marcato', '重音', 'Marcato', '清晰的强奏音头', '#e0562a', { brightness: 0.66, velocityCurve: 0.4, attack: 0.04, articulation: 'marcato' }),
  ],
  previewNotes: [0, 7, 12, 14],
  description: '田园与叙事场景的灵魂木管',
  icon: '🎺',
  styles: ['classical', 'cinematic'],
})

const HORN: InstrumentDefinition = inst({
  id: 'brass.horn',
  name: '圆号',
  nameEn: 'French Horn',
  family: 'classical',
  category: '铜管',
  engine: 'soundfont',
  gmProgram: 60,
  isDrumKit: false,
  range: { min: 40, max: 80 },
  smartKinds: ['pad', 'counter', 'melody'],
  synth: patch(
    [
      layer('fatsawtooth', {
        gain: 0.28,
        detune: 6,
        envelope: env(0.16, 0.5, 0.82, 0.55),
        filter: { type: 'lowpass', frequency: 1600, Q: 0.8, envAmount: 0.32, envelope: env(0.2, 0.8, 0.55, 0.5) },
        vibrato: { rate: 4.6, depth: 6 },
      }),
      layer('triangle', { octave: -1, gain: 0.2, envelope: env(0.2, 0.6, 0.8, 0.6) }),
      layer('sine', { octave: 1, gain: 0.1, envelope: env(0.24, 0.5, 0.75, 0.6) }),
    ],
    { velocitySensitivity: 0.4, polyphony: 12, fx: { reverb: 0.34, delay: 0.05, chorus: 0.06, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '圆润的木质铜管，内声部首选', '#d4a95c', { brightness: 0.42, warmth: 0.75, attack: 0.2, release: 0.55, articulation: 'legato' }),
    emotion('muted', '弱音', 'Stopped', '手塞弱音器的鼻音色彩', '#a97bd6', { brightness: 0.58, warmth: 0.45, drive: 0.08, articulation: 'marcato' }),
    emotion('heroic', '号角', 'Heroic', '开阔有力的主奏', '#e0562a', { brightness: 0.68, velocityCurve: 0.35, attack: 0.1, release: 0.45, articulation: 'marcato' }),
    emotion('swell', '渐强', 'Swell', '缓慢起音推向高潮', '#7f9cf5', { brightness: 0.55, attack: 0.4, release: 0.7, reverb: 0.44, articulation: 'swell' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '温暖厚实的铜管中坚，连接木管与弦乐',
  icon: '📯',
  styles: ['classical', 'cinematic', 'pop'],
})

const TRUMPET: InstrumentDefinition = inst({
  id: 'brass.trumpet',
  name: '小号',
  nameEn: 'Trumpet',
  family: 'classical',
  category: '铜管',
  engine: 'soundfont',
  gmProgram: 56,
  isDrumKit: false,
  range: { min: 55, max: 88 },
  smartKinds: ['melody', 'counter', 'riff'],
  synth: patch(
    [
      layer('sawtooth', {
        gain: 0.3,
        envelope: env(0.05, 0.3, 0.8, 0.32),
        filter: { type: 'lowpass', frequency: 3400, Q: 1.1, envAmount: 0.35, envelope: env(0.06, 0.5, 0.6, 0.3) },
        vibrato: { rate: 5.4, depth: 8 },
      }),
      layer('square', { octave: -1, gain: 0.12, envelope: env(0.06, 0.35, 0.7, 0.35) }),
      layer('sine', { octave: 1, gain: 0.1, envelope: env(0.05, 0.28, 0.6, 0.3) }),
    ],
    { monophonic: true, glide: 0.02, velocitySensitivity: 0.6, fx: { reverb: 0.2, delay: 0.06, chorus: 0, distortion: 0.04, busLowpass: 0 } },
  ),
  emotions: [
    emotion('bright', '明亮', 'Bright', '华丽的开放式铜管', '#f0d9a8', { brightness: 0.78, warmth: 0.4, velocityCurve: 0.3, articulation: 'marcato' }),
    emotion('muted', '弱音器', 'Muted', '爵士常用的哇哇弱音器', '#a97bd6', { brightness: 0.6, warmth: 0.32, drive: 0.1, vibrato: 0.16, articulation: 'sustain' }),
    emotion('fanfare', '号角', 'Fanfare', '仪式感强奏', '#e0562a', { brightness: 0.84, velocityCurve: 0.45, attack: 0.03, articulation: 'marcato' }),
    emotion('soft', '柔和', 'Soft', '抒情弱奏，适合衬托', '#d4a95c', { brightness: 0.5, warmth: 0.62, attack: 0.16, release: 0.5, articulation: 'legato' }),
    emotion('jazz', '爵士', 'Jazz', '带摇摆感的独奏小号', '#3ddbd9', { brightness: 0.68, vibrato: 0.26, vibratoRate: 5.8, drive: 0.06, articulation: 'sustain' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '最锋利的铜管声部，号角与爵士独奏',
  icon: '🎺',
  styles: ['classical', 'jazz', 'cinematic', 'pop'],
})

/* ------------------------------------------------------------------ */
/* 拨弦 / 打击 / 人声 / 管风琴                                          */
/* ------------------------------------------------------------------ */

const HARP: InstrumentDefinition = inst({
  id: 'harp',
  name: '竖琴',
  nameEn: 'Orchestral Harp',
  family: 'classical',
  category: '拨弦',
  engine: 'soundfont',
  gmProgram: 46,
  isDrumKit: false,
  range: { min: 24, max: 103 },
  smartKinds: ['arp', 'chords', 'melody', 'pad'],
  synth: patch(
    [
      layer('triangle', { gain: 0.36, envelope: env(0.003, 1.8, 0.0, 1.1), filter: pluckFilter(4200, 0.8, 0.3) }),
      layer('sine', { octave: 1, gain: 0.16, envelope: env(0.002, 1.2, 0.0, 0.9), vibrato: { rate: 5, depth: 4 } }),
      layer('sawtooth', { octave: -1, gain: 0.1, detune: 4, envelope: env(0.004, 1.4, 0.0, 0.8) }),
    ],
    { velocitySensitivity: 0.65, polyphony: 24, fx: { reverb: 0.32, delay: 0.14, chorus: 0.06, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '柔和的分解和弦', '#d4a95c', { brightness: 0.46, warmth: 0.7, release: 0.6, articulation: 'pluck' }),
    emotion('clear', '清澈', 'Clear', '晶莹的琶音颗粒', '#f0d9a8', { brightness: 0.74, warmth: 0.3, delay: 0.16, articulation: 'pluck' }),
    emotion('celestial', '空灵', 'Celestial', '大量混响与延迟的天界感', '#7f9cf5', { brightness: 0.66, warmth: 0.4, delay: 0.34, reverb: 0.52, articulation: 'harmonic' }),
    emotion('dark', '暗色', 'Dark', '低音区的木质共鸣', '#a97bd6', { brightness: 0.3, warmth: 0.8, release: 0.5, articulation: 'sustain' }),
  ],
  previewNotes: [0, 7, 12, 19],
  description: '竖琴分解和弦是影视与古典的流光',
  icon: '🪕',
  styles: ['classical', 'cinematic', 'pop'],
})

const TIMPANI: InstrumentDefinition = inst({
  id: 'timpani',
  name: '定音鼓',
  nameEn: 'Timpani',
  family: 'classical',
  category: '打击乐',
  engine: 'soundfont',
  gmProgram: 47,
  isDrumKit: false,
  range: { min: 36, max: 57 },
  smartKinds: ['bass', 'pad'],
  synth: patch(
    [
      layer('sine', { octave: -1, gain: 0.55, envelope: env(0.002, 1.1, 0.0, 0.9), filter: { type: 'lowpass', frequency: 520, Q: 1.4, envAmount: 0.4, envelope: env(0.002, 0.7, 0.0, 0.6) } }),
      layer('triangle', { octave: -2, gain: 0.22, envelope: env(0.003, 1.3, 0.0, 1.0) }),
      layer('noise', { gain: 0.09, envelope: env(0.001, 0.16, 0.0, 0.1), filter: { type: 'lowpass', frequency: 1200, Q: 0.8, envAmount: 0 } }),
    ],
    { velocitySensitivity: 0.75, polyphony: 8, fx: { reverb: 0.34, delay: 0, chorus: 0, distortion: 0.02, busLowpass: 0 } },
  ),
  emotions: [
    emotion('soft', '弱击', 'Soft', '远处的滚雷般弱击', '#7f9cf5', { brightness: 0.28, warmth: 0.9, velocityCurve: -0.3, articulation: 'sustain' }),
    emotion('marcato', '强击', 'Marcato', '有冲击力的重击', '#e0562a', { brightness: 0.42, warmth: 0.8, velocityCurve: 0.4, drive: 0.12, articulation: 'marcato' }),
    emotion('roll', '滚奏', 'Roll', '持续滚奏推情绪', '#d4a95c', { brightness: 0.36, warmth: 0.85, release: 0.7, articulation: 'tremolo' }),
    emotion('dark', '深沉', 'Dark', '极低频的影院冲击', '#a97bd6', { brightness: 0.2, warmth: 0.95, release: 0.8, articulation: 'sustain' }),
  ],
  previewNotes: [0, 0, 7, 12],
  description: '低频冲击与仪式感的核心',
  icon: '🥁',
  styles: ['classical', 'cinematic'],
})

const CHOIR: InstrumentDefinition = inst({
  id: 'choir',
  name: '合唱',
  nameEn: 'Choir',
  family: 'classical',
  category: '人声',
  engine: 'soundfont',
  gmProgram: 52,
  isDrumKit: false,
  range: { min: 48, max: 84 },
  smartKinds: ['pad', 'chords', 'melody', 'counter'],
  synth: patch(
    [
      layer('sine', { gain: 0.26, envelope: env(0.45, 0.8, 0.85, 1.1), vibrato: { rate: 5, depth: 14 }, filter: swellFilter(2400, 0.6) }),
      layer('triangle', { octave: 1, gain: 0.12, detune: 7, envelope: env(0.55, 0.7, 0.8, 1.2), vibrato: { rate: 5.4, depth: 12 } }),
      layer('fatsawtooth', { octave: -1, gain: 0.12, detune: -9, envelope: env(0.6, 0.9, 0.82, 1.3) }),
    ],
    { velocitySensitivity: 0.32, polyphony: 24, fx: { reverb: 0.48, delay: 0.1, chorus: 0.34, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('aah', '啊声', 'Aah', '开阔的合唱啊声', '#d4a95c', { brightness: 0.5, warmth: 0.68, attack: 0.4, release: 0.7, chorus: 0.36, articulation: 'sustain' }),
    emotion('ooh', '呜声', 'Ooh', '圆润收敛的呜声铺底', '#7f9cf5', { brightness: 0.34, warmth: 0.82, attack: 0.5, release: 0.8, articulation: 'legato' }),
    emotion('angelic', '天使', 'Angelic', '空灵的高音合唱', '#f0d9a8', { brightness: 0.7, warmth: 0.3, stereoWidth: 0.9, reverb: 0.55, articulation: 'swell' }),
    emotion('dark', '暗黑', 'Dark', '低音区吟唱，悬疑', '#a97bd6', { brightness: 0.24, warmth: 0.9, attack: 0.55, release: 0.85, reverb: 0.5, articulation: 'sustain' }),
    emotion('epic', '史诗', 'Epic', '大规模混声合唱', '#e0562a', { brightness: 0.6, warmth: 0.6, stereoWidth: 1, reverb: 0.52, release: 0.75, articulation: 'marcato' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '史诗/宗教场景的人声铺底',
  icon: '🎼',
  styles: ['cinematic', 'classical', 'pop'],
})

const ORGAN_PIPE: InstrumentDefinition = inst({
  id: 'organ.pipe',
  name: '管风琴',
  nameEn: 'Pipe Organ',
  family: 'classical',
  category: '键盘',
  engine: 'soundfont',
  gmProgram: 19,
  isDrumKit: false,
  range: { min: 36, max: 96 },
  smartKinds: ['pad', 'chords', 'melody'],
  synth: patch(
    [
      layer('square', { gain: 0.22, envelope: env(0.03, 0.2, 0.95, 0.25) }),
      layer('sine', { octave: 1, gain: 0.18, envelope: env(0.02, 0.2, 0.92, 0.2) }),
      layer('triangle', { octave: -1, gain: 0.24, envelope: env(0.04, 0.25, 0.9, 0.3) }),
      layer('sine', { octave: 2, gain: 0.08, envelope: env(0.02, 0.2, 0.85, 0.2) }),
    ],
    { velocitySensitivity: 0.25, polyphony: 24, fx: { reverb: 0.46, delay: 0.04, chorus: 0.2, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('full', '全奏', 'Full', '满编制管风琴，庄严宏大', '#d4a95c', { brightness: 0.6, warmth: 0.6, attack: 0.04, release: 0.3, reverb: 0.5, articulation: 'sustain' }),
    emotion('soft', '柔和', 'Soft', '弱音栓的柔和长音', '#7f9cf5', { brightness: 0.38, attack: 0.2, release: 0.6, reverb: 0.55, articulation: 'legato' }),
    emotion('bright', '明亮', 'Bright', '明亮的高音栓', '#f0d9a8', { brightness: 0.82, warmth: 0.3, reverb: 0.44, articulation: 'sustain' }),
    emotion('dark', '暗色', 'Dark', '低音栓的厚重共鸣', '#a97bd6', { brightness: 0.22, warmth: 0.92, release: 0.4, reverb: 0.5, articulation: 'sustain' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '教堂/史诗场景的铺底键盘',
  icon: '⛪',
  styles: ['classical', 'cinematic'],
})

/* ------------------------------------------------------------------ */
/* 吉他 / 贝斯 / 摇滚风琴                                               */
/* ------------------------------------------------------------------ */

const GUITAR_ACOUSTIC: InstrumentDefinition = inst({
  id: 'guitar.acoustic',
  name: '木吉他',
  nameEn: 'Acoustic Guitar',
  family: 'rock',
  category: '吉他',
  engine: 'soundfont',
  gmProgram: 25,
  isDrumKit: false,
  range: { min: 40, max: 88 },
  smartKinds: ['strum', 'chords', 'melody', 'arp', 'riff'],
  synth: patch(
    [
      layer('fattriangle', {
        gain: 0.32,
        detune: 5,
        envelope: env(0.004, 1.4, 0.0, 0.5),
        filter: { type: 'lowpass', frequency: 3600, Q: 1, envAmount: 0.4, envelope: env(0.004, 0.9, 0.05, 0.35) },
      }),
      layer('sawtooth', { octave: 1, gain: 0.08, detune: -6, envelope: env(0.004, 1.0, 0.0, 0.4) }),
      layer('sine', { octave: -1, gain: 0.16, envelope: env(0.006, 1.2, 0.0, 0.5) }),
    ],
    { velocitySensitivity: 0.66, polyphony: 12, fx: { reverb: 0.18, delay: 0.05, chorus: 0.03, distortion: 0, busLowpass: 6000 } },
  ),
  emotions: [
    emotion('finger', '指弹', 'Fingerstyle', '指腹触弦的温暖音头', '#d4a95c', { brightness: 0.52, warmth: 0.72, attack: 0.06, release: 0.5, articulation: 'pluck' }),
    emotion('strum', '扫弦', 'Strum', '拨片扫弦的开阔共鸣', '#a3b86c', { brightness: 0.66, warmth: 0.55, attack: 0.02, release: 0.42, articulation: 'sustain' }),
    emotion('bright', '明亮', 'Bright', '明亮的民谣分解', '#f0d9a8', { brightness: 0.8, warmth: 0.36, delay: 0.08, articulation: 'pluck' }),
    emotion('soft', '柔和', 'Soft', '轻柔的分解伴奏', '#7f9cf5', { brightness: 0.38, warmth: 0.76, attack: 0.12, release: 0.6, articulation: 'legato' }),
    emotion('muted', '闷音', 'Palm Mute', '手掌闷音，节奏感强', '#e0562a', { brightness: 0.42, warmth: 0.6, release: 0.1, sustain: 0.2, articulation: 'palmMute' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '民谣/流行的核心伴奏乐器',
  icon: '🎸',
  styles: ['folk', 'pop', 'rock'],
})

const GUITAR_ELEC: InstrumentDefinition = inst({
  id: 'guitar.electric',
  name: '电吉他',
  nameEn: 'Electric Guitar',
  family: 'rock',
  category: '吉他',
  engine: 'soundfont',
  gmProgram: 27,
  isDrumKit: false,
  range: { min: 40, max: 88 },
  smartKinds: ['riff', 'chords', 'melody', 'strum', 'counter'],
  synth: patch(
    [
      layer('sawtooth', {
        gain: 0.32,
        envelope: env(0.006, 0.8, 0.0, 0.35),
        filter: { type: 'lowpass', frequency: 2800, Q: 1.6, envAmount: 0.5, envelope: env(0.004, 0.9, 0.1, 0.4) },
      }),
      layer('square', { octave: 1, gain: 0.1, detune: 3, envelope: env(0.005, 0.6, 0.0, 0.3) }),
      layer('triangle', { octave: -1, gain: 0.12, envelope: env(0.006, 0.9, 0.0, 0.4) }),
    ],
    { velocitySensitivity: 0.6, polyphony: 12, fx: { reverb: 0.16, delay: 0.1, chorus: 0.08, distortion: 0.14, busLowpass: 5200 } },
  ),
  emotions: [
    emotion('clean', '清音', 'Clean', '干净清脆的清音分解', '#3ddbd9', { brightness: 0.62, drive: 0, reverb: 0.22, chorus: 0.16, articulation: 'pluck' }),
    emotion('crunch', '过载', 'Crunch', '轻度过载的经典摇滚节奏', '#e0562a', { brightness: 0.66, drive: 0.38, reverb: 0.14, articulation: 'sustain' }),
    emotion('gain', '高增益', 'High Gain', '厚实失真的主音与强力和弦', '#f472b6', { brightness: 0.72, warmth: 0.62, drive: 0.78, reverb: 0.1, articulation: 'sustain' }),
    emotion('chime', '泛音', 'Chime', '泛音与延迟营造氛围', '#7f9cf5', { brightness: 0.88, delay: 0.34, reverb: 0.34, chorus: 0.24, articulation: 'harmonic' }),
    emotion('muted', '闷音', 'Palm Mute', '掌闷颗粒，推进感强', '#a3b86c', { brightness: 0.48, drive: 0.5, release: 0.1, sustain: 0.15, articulation: 'palmMute' }),
  ],
  previewNotes: [0, 7, 12, 15],
  description: '摇滚与流行的节奏/主音吉他',
  icon: '🎸',
  styles: ['rock', 'pop', 'jazz'],
})

const GUITAR_DIST: InstrumentDefinition = inst({
  id: 'guitar.electric.dist',
  name: '失真吉他',
  nameEn: 'Distortion Guitar',
  family: 'rock',
  category: '吉他',
  engine: 'soundfont',
  gmProgram: 30,
  isDrumKit: false,
  range: { min: 40, max: 88 },
  smartKinds: ['riff', 'chords', 'melody'],
  synth: patch(
    [
      layer('sawtooth', {
        gain: 0.3,
        envelope: env(0.005, 0.9, 0.35, 0.3),
        filter: { type: 'lowpass', frequency: 3800, Q: 1.1, envAmount: 0.3, envelope: env(0.004, 0.7, 0.25, 0.3) },
      }),
      layer('square', { octave: -1, gain: 0.18, detune: 8, envelope: env(0.006, 1.0, 0.3, 0.35) }),
      layer('sawtooth', { octave: 1, gain: 0.1, detune: -9, envelope: env(0.005, 0.7, 0.25, 0.3) }),
    ],
    { velocitySensitivity: 0.55, polyphony: 10, fx: { reverb: 0.14, delay: 0.08, chorus: 0, distortion: 0.55, busLowpass: 5600 } },
  ),
  emotions: [
    emotion('highGain', '高增益', 'High Gain', '现代金属的高增益墙', '#e0562a', { brightness: 0.74, warmth: 0.6, drive: 0.85, articulation: 'palmMute' }),
    emotion('fuzz', '法兹', 'Fuzz', '复古法兹毛刺感', '#d4a95c', { brightness: 0.6, warmth: 0.7, drive: 0.7, articulation: 'sustain' }),
    emotion('metal', '金属', 'Metal', '中频突出、颗粒锋利', '#f472b6', { brightness: 0.82, warmth: 0.45, drive: 0.9, articulation: 'marcato' }),
    emotion('lead', '主音', 'Lead', '带延迟的歌唱性主音', '#7f9cf5', { brightness: 0.7, drive: 0.6, delay: 0.26, reverb: 0.24, articulation: 'sustain' }),
  ],
  previewNotes: [0, 7, 12, 19],
  description: '摇滚/金属的失真墙与主音',
  icon: '🎸',
  styles: ['rock'],
})

const GUITAR_JAZZ: InstrumentDefinition = inst({
  id: 'guitar.jazz',
  name: '爵士吉他',
  nameEn: 'Jazz Guitar',
  family: 'rock',
  category: '吉他',
  engine: 'soundfont',
  gmProgram: 26,
  isDrumKit: false,
  range: { min: 40, max: 84 },
  smartKinds: ['chords', 'melody', 'counter', 'strum'],
  synth: patch(
    [
      layer('sawtooth', {
        gain: 0.26,
        envelope: env(0.008, 1.0, 0.2, 0.4),
        filter: { type: 'lowpass', frequency: 1700, Q: 1.8, envAmount: 0.28, envelope: env(0.006, 0.8, 0.2, 0.35) },
      }),
      layer('triangle', { octave: -1, gain: 0.22, envelope: env(0.01, 1.2, 0.18, 0.45) }),
      layer('sine', { octave: 1, gain: 0.08, envelope: env(0.008, 0.8, 0.1, 0.3) }),
    ],
    { velocitySensitivity: 0.6, polyphony: 12, fx: { reverb: 0.22, delay: 0.06, chorus: 0.06, distortion: 0.02, busLowpass: 3600 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '空心爵士吉他的温暖和弦', '#d4a95c', { brightness: 0.4, warmth: 0.8, attack: 0.06, release: 0.5, articulation: 'sustain' }),
    emotion('hollow', '空心', 'Hollow', '中频凹陷的空心共鸣', '#a97bd6', { brightness: 0.5, warmth: 0.7, reverb: 0.26, articulation: 'pluck' }),
    emotion('bright', '明亮', 'Bright', '拨片弹奏的清晰线条', '#f0d9a8', { brightness: 0.72, warmth: 0.42, attack: 0.03, articulation: 'pluck' }),
    emotion('muted', '闷音', 'Muted', '轻闷的节奏和弦（ Freddie Green 风格）', '#a3b86c', { brightness: 0.44, warmth: 0.6, release: 0.14, sustain: 0.2, articulation: 'palmMute' }),
  ],
  previewNotes: [0, 4, 10, 14],
  description: '爵士四重奏的和弦声部',
  icon: '🎸',
  styles: ['jazz', 'folk'],
})

const GUITAR_BASS: InstrumentDefinition = inst({
  id: 'guitar.bass',
  name: '贝斯',
  nameEn: 'Bass Guitar',
  family: 'rock',
  category: '贝斯',
  engine: 'soundfont',
  gmProgram: 33,
  isDrumKit: false,
  range: { min: 28, max: 67 },
  smartKinds: ['bass', 'riff', 'counter'],
  synth: patch(
    [
      layer('triangle', { octave: -1, gain: 0.48, envelope: env(0.008, 0.6, 0.45, 0.25), filter: { type: 'lowpass', frequency: 1250, Q: 1.3, envAmount: 0.32, envelope: env(0.006, 0.5, 0.3, 0.25) } }),
      layer('sawtooth', { octave: -1, gain: 0.15, detune: 3, envelope: env(0.01, 0.7, 0.3, 0.3) }),
      layer('sine', { octave: -2, gain: 0.22, envelope: env(0.01, 0.8, 0.55, 0.3) }),
    ],
    { velocitySensitivity: 0.55, polyphony: 6, fx: { reverb: 0.06, delay: 0, chorus: 0.02, distortion: 0.03, busLowpass: 4200 } },
  ),
  emotions: [
    emotion('finger', '指弹', 'Finger', '自然的指弹音头，流行/民谣', '#a3b86c', { brightness: 0.45, warmth: 0.68, attack: 0.02, release: 0.24, articulation: 'pluck' }),
    emotion('pick', '拨片', 'Pick', '明亮有攻击性的摇滚贝斯', '#e0562a', { brightness: 0.7, warmth: 0.4, attack: 0.01, drive: 0.08, articulation: 'pluck' }),
    emotion('round', '圆润', 'Round', '厚实温暖的底，适合铺底', '#d4a95c', { brightness: 0.35, warmth: 0.82, release: 0.32, articulation: 'sustain' }),
    emotion('drive', '过载', 'Drive', '摇滚失真贝斯的推进', '#f472b6', { brightness: 0.55, drive: 0.42, sustain: 0.4, articulation: 'marcato' }),
    emotion('slap', '击弦', 'Slap', '放克击弦的短促爆发', '#3ddbd9', { brightness: 0.78, warmth: 0.45, attack: 0.005, release: 0.12, velocityCurve: 0.35, articulation: 'staccato' }),
  ],
  previewNotes: [0, 0, 7, 5],
  description: '连接鼓与和声的低频声部',
  icon: '🎸',
  styles: ['rock', 'pop', 'jazz', 'folk'],
})

const ORGAN_ROCK: InstrumentDefinition = inst({
  id: 'organ.rock',
  name: '摇滚风琴',
  nameEn: 'Rock Organ',
  family: 'rock',
  category: '键盘',
  engine: 'soundfont',
  gmProgram: 18,
  isDrumKit: false,
  range: { min: 36, max: 96 },
  smartKinds: ['pad', 'chords', 'riff', 'melody'],
  synth: patch(
    [
      layer('square', { gain: 0.24, envelope: env(0.012, 0.3, 0.9, 0.16), filter: { type: 'lowpass', frequency: 3200, Q: 0.9, envAmount: 0.2, envelope: env(0.01, 0.4, 0.6, 0.2) } }),
      layer('sawtooth', { octave: 1, gain: 0.14, detune: 5, envelope: env(0.012, 0.3, 0.85, 0.18) }),
      layer('triangle', { octave: -1, gain: 0.22, envelope: env(0.016, 0.35, 0.9, 0.2) }),
    ],
    { velocitySensitivity: 0.3, polyphony: 16, fx: { reverb: 0.18, delay: 0.06, chorus: 0.22, distortion: 0.1, busLowpass: 5200 } },
  ),
  emotions: [
    emotion('dirty', '脏音', 'Dirty', '过载的摇滚风琴，带咆哮', '#e0562a', { brightness: 0.62, warmth: 0.6, drive: 0.35, chorus: 0.2, articulation: 'sustain' }),
    emotion('drawbar', '拉杆', 'Drawbar', '经典拉杆音色的饱满和声', '#d4a95c', { brightness: 0.55, warmth: 0.68, chorus: 0.26, articulation: 'sustain' }),
    emotion('percussive', '打击音头', 'Percussive', '带打击音头的短促和弦', '#3ddbd9', { brightness: 0.7, attack: 0.01, release: 0.18, articulation: 'staccato' }),
    emotion('smooth', '顺滑', 'Smooth', '柔化高频的铺底', '#7f9cf5', { brightness: 0.38, warmth: 0.78, attack: 0.08, release: 0.4, chorus: 0.3, articulation: 'legato' }),
  ],
  previewNotes: [0, 4, 7, 12],
  description: '摇滚/灵魂乐的和声铺底',
  icon: '🎹',
  styles: ['rock', 'pop', 'jazz'],
})

/* ------------------------------------------------------------------ */
/* 电子                                                                */
/* ------------------------------------------------------------------ */

const SYNTH_PAD: InstrumentDefinition = inst({
  id: 'synth.pad',
  name: '合成器铺底',
  nameEn: 'Synth Pad',
  family: 'electronic',
  category: '合成器',
  engine: 'synth',
  gmProgram: 89,
  isDrumKit: false,
  range: { min: 36, max: 96 },
  smartKinds: ['pad', 'chords', 'arp', 'counter'],
  synth: patch(
    [
      layer('fatsawtooth', {
        gain: 0.22,
        detune: 14,
        envelope: env(0.62, 1.4, 0.8, 1.8),
        filter: { type: 'lowpass', frequency: 1800, Q: 0.7, envAmount: 0.42, envelope: env(0.9, 1.6, 0.5, 1.2) },
        vibrato: { rate: 0.8, depth: 5 },
      }),
      layer('triangle', { octave: 1, gain: 0.11, detune: -9, envelope: env(0.9, 1.4, 0.72, 1.9) }),
      layer('sine', { octave: -1, gain: 0.18, envelope: env(0.4, 1.0, 0.82, 1.5) }),
    ],
    { velocitySensitivity: 0.3, polyphony: 20, fx: { reverb: 0.42, delay: 0.14, chorus: 0.32, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '柔和的模拟味铺底', '#d4a95c', { brightness: 0.45, warmth: 0.75, attack: 0.55, release: 0.7, reverb: 0.36, articulation: 'sustain' }),
    emotion('cold', '冷冽', 'Cold', '高频明亮、空间感强', '#3ddbd9', { brightness: 0.8, warmth: 0.22, stereoWidth: 0.9, reverb: 0.46, articulation: 'sustain' }),
    emotion('dark', '暗黑', 'Dark', '低频厚、滤波收紧', '#a97bd6', { brightness: 0.26, warmth: 0.82, release: 0.8, articulation: 'sustain' }),
    emotion('bright', '明亮', 'Bright', '开阔的 EDM 铺底', '#f0d9a8', { brightness: 0.74, attack: 0.4, release: 0.55, chorus: 0.42, articulation: 'sustain' }),
    emotion('glass', '玻璃', 'Glass', '清透的玻璃质感合成器', '#7f9cf5', { brightness: 0.86, warmth: 0.24, attack: 0.3, release: 0.66, delay: 0.28, articulation: 'swell' }),
  ],
  previewNotes: [0, 4, 7, 11],
  description: '电子与影视配乐的氛围基底',
  icon: '🌫️',
  styles: ['electronic', 'cinematic', 'pop'],
})

const SYNTH_LEAD: InstrumentDefinition = inst({
  id: 'synth.lead',
  name: '合成器主音',
  nameEn: 'Synth Lead',
  family: 'electronic',
  category: '合成器',
  engine: 'synth',
  gmProgram: 81,
  isDrumKit: false,
  range: { min: 48, max: 96 },
  smartKinds: ['melody', 'counter', 'arp', 'riff'],
  synth: patch(
    [
      layer('sawtooth', {
        gain: 0.32,
        detune: 4,
        envelope: env(0.012, 0.35, 0.78, 0.28),
        filter: { type: 'lowpass', frequency: 3200, Q: 1.3, envAmount: 0.45, envelope: env(0.01, 0.5, 0.55, 0.3) },
        vibrato: { rate: 5.5, depth: 8 },
      }),
      layer('square', { octave: 1, gain: 0.1, detune: -6, envelope: env(0.014, 0.3, 0.7, 0.26) }),
      layer('triangle', { octave: -1, gain: 0.14, envelope: env(0.012, 0.4, 0.72, 0.3) }),
    ],
    { monophonic: true, glide: 0.035, velocitySensitivity: 0.5, polyphony: 4, fx: { reverb: 0.2, delay: 0.24, chorus: 0.08, distortion: 0.06, busLowpass: 0 } },
  ),
  emotions: [
    emotion('saw', '锯齿', 'Saw', '宽厚锯齿波主音', '#3ddbd9', { brightness: 0.7, warmth: 0.5, vibrato: 0.18, articulation: 'sustain' }),
    emotion('square', '方波', 'Square', '复古 8-bit 方波主音', '#f0d9a8', { brightness: 0.76, warmth: 0.35, drive: 0.1, articulation: 'sustain' }),
    emotion('soft', '柔和', 'Soft', '柔化滤波的抒情主音', '#7f9cf5', { brightness: 0.42, warmth: 0.7, attack: 0.16, release: 0.5, articulation: 'legato' }),
    emotion('bright', '明亮', 'Bright', 'EDM 副歌的高能主音', '#f472b6', { brightness: 0.9, warmth: 0.3, drive: 0.18, delay: 0.28, articulation: 'marcato' }),
    emotion('acid', '酸性', 'Acid', '高共振扫频的酸性主音', '#a3b86c', { brightness: 0.66, warmth: 0.42, drive: 0.3, articulation: 'pluck' }),
  ],
  previewNotes: [0, 7, 12, 10],
  description: '电子/流行的主旋律声部',
  icon: '🎛️',
  styles: ['electronic', 'pop', 'cinematic'],
})

const SYNTH_PLUCK: InstrumentDefinition = inst({
  id: 'synth.pluck',
  name: '合成拨弦',
  nameEn: 'Synth Pluck',
  family: 'electronic',
  category: '合成器',
  engine: 'synth',
  gmProgram: 84,
  isDrumKit: false,
  range: { min: 48, max: 96 },
  smartKinds: ['arp', 'melody', 'chords', 'strum'],
  synth: patch(
    [
      layer('square', {
        gain: 0.28,
        envelope: env(0.002, 0.42, 0.0, 0.24),
        filter: pluckFilter(4200, 1.6, 0.55),
      }),
      layer('sine', { octave: 1, gain: 0.14, envelope: env(0.002, 0.3, 0.0, 0.2), vibrato: { rate: 6, depth: 4 } }),
      layer('triangle', { octave: -1, gain: 0.12, envelope: env(0.003, 0.4, 0.0, 0.22) }),
    ],
    { velocitySensitivity: 0.5, polyphony: 16, fx: { reverb: 0.24, delay: 0.22, chorus: 0.1, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('pluck', '拨弦', 'Pluck', '短促清脆的电子拨弦', '#3ddbd9', { brightness: 0.72, warmth: 0.4, release: 0.14, delay: 0.2, articulation: 'pluck' }),
    emotion('bell', '铃音', 'Bell', '带 FM 质感的铃音', '#f0d9a8', { brightness: 0.84, warmth: 0.3, delay: 0.26, reverb: 0.3, articulation: 'harmonic' }),
    emotion('dark', '暗色', 'Dark', '滤波关闭的厚重拨弦', '#a97bd6', { brightness: 0.3, warmth: 0.78, release: 0.26, articulation: 'pluck' }),
    emotion('bright', '亮色', 'Bright', '明亮跳跃的 House 拨弦', '#f472b6', { brightness: 0.9, warmth: 0.34, delay: 0.18, articulation: 'staccato' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '琶音与律动型的电子颗粒',
  icon: '✨',
  styles: ['electronic', 'pop', 'cinematic'],
})

const SYNTH_BASS: InstrumentDefinition = inst({
  id: 'synth.bass',
  name: '合成器贝斯',
  nameEn: 'Synth Bass',
  family: 'electronic',
  category: '合成器',
  engine: 'synth',
  gmProgram: 38,
  isDrumKit: false,
  range: { min: 24, max: 64 },
  smartKinds: ['bass', 'riff', 'arp'],
  synth: patch(
    [
      layer('sawtooth', { octave: -1, gain: 0.46, envelope: env(0.006, 0.32, 0.62, 0.16), filter: { type: 'lowpass', frequency: 900, Q: 2.2, envAmount: 0.6, envelope: env(0.004, 0.3, 0.25, 0.2) } }),
      layer('sine', { octave: -2, gain: 0.32, envelope: env(0.004, 0.42, 0.78, 0.2) }),
      layer('square', { octave: -1, gain: 0.08, detune: 7, envelope: env(0.008, 0.3, 0.5, 0.16) }),
    ],
    { monophonic: true, glide: 0.04, velocitySensitivity: 0.5, polyphony: 4, fx: { reverb: 0.04, delay: 0, chorus: 0, distortion: 0.06, busLowpass: 3000 } },
  ),
  emotions: [
    emotion('round', '圆润', 'Round', '柔和的老式合成贝斯', '#3ddbd9', { brightness: 0.4, warmth: 0.72, release: 0.22, articulation: 'sustain' }),
    emotion('acid', '酸性', 'Acid', '高共振扫频的酸性贝斯', '#a3b86c', { brightness: 0.7, warmth: 0.4, drive: 0.12, articulation: 'pluck' }),
    emotion('sub', '低频', 'Sub', '纯正弦超低频', '#7f9cf5', { brightness: 0.18, warmth: 0.9, release: 0.24, articulation: 'sustain' }),
    emotion('drive', '驱动', 'Drive', '失真推进的电子贝斯', '#e0562a', { brightness: 0.62, drive: 0.46, articulation: 'marcato' }),
  ],
  previewNotes: [0, 0, 7, 5],
  description: '电子律动的低频核心',
  icon: '🎛️',
  styles: ['electronic', 'rock', 'pop'],
})

const SYNTH_ARP: InstrumentDefinition = inst({
  id: 'synth.arp',
  name: '琶音合成器',
  nameEn: 'Synth Arp',
  family: 'electronic',
  category: '合成器',
  engine: 'synth',
  gmProgram: 82,
  isDrumKit: false,
  range: { min: 48, max: 100 },
  smartKinds: ['arp', 'melody', 'counter'],
  synth: patch(
    [
      layer('square', { gain: 0.24, envelope: env(0.002, 0.3, 0.15, 0.18), filter: pluckFilter(3600, 2.2, 0.6) }),
      layer('sine', { octave: 1, gain: 0.12, envelope: env(0.002, 0.24, 0.1, 0.16), vibrato: { rate: 6.5, depth: 5 } }),
      layer('sawtooth', { octave: -1, gain: 0.1, detune: -7, envelope: env(0.004, 0.3, 0.12, 0.2) }),
    ],
    { velocitySensitivity: 0.45, polyphony: 16, fx: { reverb: 0.22, delay: 0.3, chorus: 0.16, distortion: 0.02, busLowpass: 0 } },
  ),
  emotions: [
    emotion('sparkle', '闪耀', 'Sparkle', '闪烁的 16 分琶音', '#3ddbd9', { brightness: 0.86, warmth: 0.3, delay: 0.32, articulation: 'pluck' }),
    emotion('bell', '铃音', 'Bell', '清脆的铃铛琶音', '#f0d9a8', { brightness: 0.78, warmth: 0.36, reverb: 0.32, articulation: 'harmonic' }),
    emotion('soft', '柔和', 'Soft', '柔化滤波的梦幻琶音', '#7f9cf5', { brightness: 0.42, warmth: 0.72, attack: 0.1, release: 0.42, articulation: 'legato' }),
    emotion('glitch', '故障', 'Glitch', '短促、干硬的故障音色', '#f472b6', { brightness: 0.7, warmth: 0.28, release: 0.1, articulation: 'staccato' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '电子音乐流动的琶音声部',
  icon: '✨',
  styles: ['electronic', 'cinematic', 'pop'],
})

/* ------------------------------------------------------------------ */
/* 鼓组                                                                */
/* ------------------------------------------------------------------ */

const DRUMS_ACOUSTIC: InstrumentDefinition = inst({
  id: 'drums.acoustic',
  name: '原声鼓组',
  nameEn: 'Acoustic Kit',
  family: 'drums',
  category: '鼓组',
  engine: 'soundfont',
  gmProgram: 0,
  isDrumKit: true,
  range: { min: 35, max: 81 },
  smartKinds: ['drums'],
  synth: patch(
    [
      layer('sine', { octave: -2, gain: 0.55, envelope: env(0.001, 0.22, 0.0, 0.09), filter: { type: 'lowpass', frequency: 260, Q: 1.2, envAmount: 0.3, envelope: env(0.001, 0.14, 0.0, 0.06) } }),
      layer('noise', { gain: 0.42, envelope: env(0.001, 0.13, 0.0, 0.05), filter: { type: 'bandpass', frequency: 1800, Q: 0.9, envAmount: 0.2, envelope: env(0.001, 0.1, 0.0, 0.04) } }),
      layer('triangle', { octave: -1, gain: 0.16, envelope: env(0.001, 0.16, 0.0, 0.07) }),
    ],
    { velocitySensitivity: 0.8, polyphony: 24, fx: { reverb: 0.16, delay: 0, chorus: 0, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('studio', '录音室', 'Studio', '干净紧实的流行鼓', '#f472b6', { brightness: 0.58, warmth: 0.55, reverb: 0.14, articulation: 'marcato' }),
    emotion('room', '房间感', 'Room', '自然房间混响的开阔鼓', '#d4a95c', { brightness: 0.5, warmth: 0.65, reverb: 0.34, articulation: 'sustain' }),
    emotion('power', '力量', 'Power', '摇滚大鼓厚军鼓', '#e0562a', { brightness: 0.66, warmth: 0.72, drive: 0.2, reverb: 0.2, velocityCurve: 0.3, articulation: 'marcato' }),
    emotion('brush', '刷奏', 'Brush', '爵士刷子扫过的沙沙声', '#a97bd6', { brightness: 0.4, warmth: 0.6, reverb: 0.28, articulation: 'swell' }),
    emotion('tight', '紧致', 'Tight', '短促干爽的电子化原声鼓', '#3ddbd9', { brightness: 0.7, warmth: 0.42, release: 0.08, reverb: 0.08, articulation: 'staccato' }),
  ],
  previewNotes: [36, 38, 42, 42],
  description: '通用原声鼓组，覆盖流行/摇滚/爵士',
  icon: '🥁',
  styles: ['rock', 'pop', 'folk', 'jazz'],
})

const DRUMS_JAZZ: InstrumentDefinition = inst({
  id: 'drums.jazz',
  name: '爵士鼓',
  nameEn: 'Jazz Kit',
  family: 'drums',
  category: '鼓组',
  engine: 'soundfont',
  gmProgram: 0,
  isDrumKit: true,
  range: { min: 35, max: 81 },
  smartKinds: ['drums'],
  synth: patch(
    [
      layer('sine', { octave: -2, gain: 0.4, envelope: env(0.002, 0.3, 0.0, 0.12), filter: { type: 'lowpass', frequency: 200, Q: 1, envAmount: 0.25 } }),
      layer('noise', { gain: 0.36, envelope: env(0.002, 0.26, 0.0, 0.1), filter: { type: 'bandpass', frequency: 2400, Q: 1.2, envAmount: 0.15 } }),
      layer('triangle', { octave: -1, gain: 0.12, envelope: env(0.002, 0.35, 0.0, 0.12) }),
    ],
    { velocitySensitivity: 0.85, polyphony: 24, fx: { reverb: 0.3, delay: 0, chorus: 0, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('brush', '刷子', 'Brush', '刷子扫鼓，摇摆感觉', '#a97bd6', { brightness: 0.4, warmth: 0.62, reverb: 0.3, articulation: 'swell' }),
    emotion('ride', '骑镲', 'Ride', '骑镲主导的轻盈律动', '#d4a95c', { brightness: 0.6, warmth: 0.5, reverb: 0.24, articulation: 'sustain' }),
    emotion('bop', '比波普', 'Bop', '快速密集的比波普鼓点', '#e0562a', { brightness: 0.68, warmth: 0.46, reverb: 0.2, velocityCurve: 0.3, articulation: 'marcato' }),
    emotion('soft', '轻柔', 'Soft', '极弱的爵士小音量', '#7f9cf5', { brightness: 0.32, warmth: 0.7, release: 0.3, reverb: 0.34, velocityCurve: -0.3, articulation: 'sustain' }),
  ],
  previewNotes: [51, 42, 38, 36],
  description: '爵士三重奏/四重奏的鼓组',
  icon: '🥁',
  styles: ['jazz'],
})

const DRUMS_ELECTRONIC: InstrumentDefinition = inst({
  id: 'drums.electronic',
  name: '电子鼓机',
  nameEn: 'Drum Machine',
  family: 'drums',
  category: '鼓组',
  engine: 'synth',
  gmProgram: 0,
  isDrumKit: true,
  range: { min: 35, max: 81 },
  smartKinds: ['drums'],
  synth: patch(
    [
      layer('sine', { octave: -2, gain: 0.6, envelope: env(0.001, 0.26, 0.0, 0.07), filter: { type: 'lowpass', frequency: 320, Q: 1.4, envAmount: 0.35, envelope: env(0.001, 0.12, 0.0, 0.05) } }),
      layer('noise', { gain: 0.4, envelope: env(0.001, 0.08, 0.0, 0.03), filter: { type: 'highpass', frequency: 2200, Q: 0.7, envAmount: 0.2 } }),
      layer('square', { octave: -1, gain: 0.12, envelope: env(0.001, 0.12, 0.0, 0.04) }),
    ],
    { velocitySensitivity: 0.6, polyphony: 24, fx: { reverb: 0.12, delay: 0.04, chorus: 0, distortion: 0.05, busLowpass: 0 } },
  ),
  emotions: [
    emotion('punch', '紧实', 'Punch', '短促有力的 House 鼓', '#3ddbd9', { brightness: 0.64, warmth: 0.55, reverb: 0.1, articulation: 'marcato' }),
    emotion('808', '808', '808', '长尾低频 808', '#7f9cf5', { brightness: 0.28, warmth: 0.92, release: 0.5, articulation: 'sustain' }),
    emotion('industrial', '工业', 'Industrial', '失真金属质感的工业鼓', '#e0562a', { brightness: 0.82, warmth: 0.4, drive: 0.5, reverb: 0.24, articulation: 'marcato' }),
    emotion('lofi', 'Lo-Fi', 'Lo-Fi', '闷而温暖的复古鼓', '#d4a95c', { brightness: 0.3, warmth: 0.74, reverb: 0.2, articulation: 'sustain' }),
  ],
  previewNotes: [36, 39, 42, 46],
  description: 'House / Techno / Hip-hop 鼓机音色',
  icon: '🤖',
  styles: ['electronic', 'pop'],
})

/* ------------------------------------------------------------------ */
/* 世界 / 色彩                                                          */
/* ------------------------------------------------------------------ */

const MARIMBA: InstrumentDefinition = inst({
  id: 'marimba',
  name: '马林巴',
  nameEn: 'Marimba',
  family: 'world',
  category: '键盘打击',
  engine: 'soundfont',
  gmProgram: 12,
  isDrumKit: false,
  range: { min: 45, max: 96 },
  smartKinds: ['arp', 'melody', 'chords', 'counter'],
  synth: patch(
    [
      layer('sine', { gain: 0.4, envelope: env(0.002, 0.7, 0.0, 0.4), filter: pluckFilter(2400, 0.8, 0.25) }),
      layer('triangle', { octave: 1, gain: 0.16, envelope: env(0.002, 0.5, 0.0, 0.3), vibrato: { rate: 5, depth: 3 } }),
      layer('sine', { octave: -1, gain: 0.14, envelope: env(0.003, 0.6, 0.0, 0.35) }),
    ],
    { velocitySensitivity: 0.6, polyphony: 16, fx: { reverb: 0.24, delay: 0.08, chorus: 0, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('warm', '温暖', 'Warm', '木质共鸣的温暖音色', '#d4a95c', { brightness: 0.46, warmth: 0.72, release: 0.4, articulation: 'pluck' }),
    emotion('bright', '明亮', 'Bright', '明亮清脆的琴键', '#f0d9a8', { brightness: 0.78, warmth: 0.36, release: 0.3, articulation: 'pluck' }),
    emotion('soft', '柔和', 'Soft', '软槌的柔和滚奏', '#7f9cf5', { brightness: 0.34, warmth: 0.8, attack: 0.04, release: 0.55, articulation: 'legato' }),
    emotion('woody', '木质', 'Woody', '干燥木质、短促颗粒', '#a3b86c', { brightness: 0.52, warmth: 0.66, release: 0.18, sustain: 0.2, articulation: 'staccato' }),
  ],
  previewNotes: [0, 4, 7, 12],
  description: '温暖木质的世界色彩打击乐',
  icon: '🎵',
  styles: ['cinematic', 'folk', 'pop'],
})

const CELESTA: InstrumentDefinition = inst({
  id: 'celesta',
  name: '钢片琴',
  nameEn: 'Celesta',
  family: 'world',
  category: '键盘打击',
  engine: 'soundfont',
  gmProgram: 8,
  isDrumKit: false,
  range: { min: 60, max: 108 },
  smartKinds: ['arp', 'melody', 'chords'],
  synth: patch(
    [
      layer('sine', { octave: 1, gain: 0.3, envelope: env(0.002, 1.2, 0.0, 0.9) }),
      layer('fm', { gain: 0.16, fm: { harmonicity: 3.5, modulationIndex: 2.2 }, envelope: env(0.002, 0.9, 0.0, 0.7) }),
      layer('triangle', { gain: 0.12, envelope: env(0.003, 1.0, 0.0, 0.8) }),
    ],
    { velocitySensitivity: 0.6, polyphony: 20, fx: { reverb: 0.34, delay: 0.16, chorus: 0.06, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('bell', '钟声', 'Bell', '晶莹的钟琴质感', '#f0d9a8', { brightness: 0.8, warmth: 0.32, delay: 0.2, articulation: 'pluck' }),
    emotion('dreamy', '梦幻', 'Dreamy', '长混响的梦幻音色', '#7f9cf5', { brightness: 0.6, warmth: 0.46, reverb: 0.52, delay: 0.28, articulation: 'sustain' }),
    emotion('bright', '明亮', 'Bright', '透明的高音闪光', '#3ddbd9', { brightness: 0.9, warmth: 0.24, release: 0.6, articulation: 'pluck' }),
    emotion('soft', '柔和', 'Soft', '轻柔的伴奏音色', '#d4a95c', { brightness: 0.4, warmth: 0.68, attack: 0.06, release: 0.7, articulation: 'legato' }),
  ],
  previewNotes: [0, 4, 7, 11],
  description: '空灵钟声，童话/悬疑色彩',
  icon: '🔔',
  styles: ['cinematic', 'classical', 'pop'],
})

const KALIMBA: InstrumentDefinition = inst({
  id: 'kalimba',
  name: '卡林巴',
  nameEn: 'Kalimba',
  family: 'world',
  category: '拨弦',
  engine: 'soundfont',
  gmProgram: 108,
  isDrumKit: false,
  range: { min: 48, max: 88 },
  smartKinds: ['arp', 'melody', 'pad'],
  synth: patch(
    [
      layer('sine', { gain: 0.34, envelope: env(0.003, 1.1, 0.0, 0.8), filter: pluckFilter(3000, 1, 0.3) }),
      layer('triangle', { octave: 1, gain: 0.14, envelope: env(0.002, 0.7, 0.0, 0.5), vibrato: { rate: 5.6, depth: 5 } }),
      layer('sine', { octave: -1, gain: 0.1, envelope: env(0.004, 0.9, 0.0, 0.6) }),
    ],
    { velocitySensitivity: 0.55, polyphony: 12, fx: { reverb: 0.26, delay: 0.14, chorus: 0, distortion: 0, busLowpass: 0 } },
  ),
  emotions: [
    emotion('thumb', '拇指琴', 'Thumb', '木质拨片的标志性音色', '#d4a95c', { brightness: 0.5, warmth: 0.72, release: 0.42, articulation: 'pluck' }),
    emotion('soft', '柔和', 'Soft', '轻柔的分解音型', '#7f9cf5', { brightness: 0.36, warmth: 0.78, attack: 0.05, release: 0.6, articulation: 'legato' }),
    emotion('dreamy', '梦幻', 'Dreamy', '带延迟的梦幻氛围', '#a97bd6', { brightness: 0.6, warmth: 0.5, delay: 0.26, reverb: 0.42, articulation: 'sustain' }),
    emotion('bright', '明亮', 'Bright', '清脆明亮的高音', '#f0d9a8', { brightness: 0.8, warmth: 0.3, release: 0.32, articulation: 'staccato' }),
  ],
  previewNotes: [0, 7, 12, 16],
  description: '温暖治愈的拨弦色彩乐器',
  icon: '🎶',
  styles: ['folk', 'pop', 'cinematic'],
})

export const INSTRUMENT_CATALOG: InstrumentDefinition[] = [
  /* 古典 / 管弦 */
  PIANO,
  STRINGS,
  VIOLIN,
  CELLO,
  DOUBLE_BASS,
  FLUTE,
  CLARINET,
  OBOE,
  HORN,
  TRUMPET,
  HARP,
  TIMPANI,
  CHOIR,
  ORGAN_PIPE,
  /* 摇滚 / 流行 / 爵士 */
  PIANO_ELECTRIC,
  GUITAR_ACOUSTIC,
  GUITAR_ELEC,
  GUITAR_DIST,
  GUITAR_JAZZ,
  GUITAR_BASS,
  ORGAN_ROCK,
  /* 电子 */
  SYNTH_PAD,
  SYNTH_LEAD,
  SYNTH_PLUCK,
  SYNTH_BASS,
  SYNTH_ARP,
  /* 鼓组 */
  DRUMS_ACOUSTIC,
  DRUMS_JAZZ,
  DRUMS_ELECTRONIC,
  /* 世界 / 色彩 */
  MARIMBA,
  CELESTA,
  KALIMBA,
]


