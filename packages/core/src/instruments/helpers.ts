import type { EmotionParams, EmotionPreset, LayerSpec, SynthPatch } from './types.js'
import { BASE_EMOTION_PARAMS, DEFAULT_FX } from './types.js'

/** 构造情绪预设：以基线参数为底，覆盖部分字段 */
export function emotion(
  id: string,
  name: string,
  nameEn: string,
  hint: string,
  color: string,
  params: Partial<EmotionParams> = {},
): EmotionPreset {
  return { id, name, nameEn, hint, color, params: { ...BASE_EMOTION_PARAMS, ...params } }
}

/** 构造振荡器层 */
export function layer(osc: LayerSpec['osc'], opts: Partial<LayerSpec> = {}): LayerSpec {
  return { osc, octave: 0, detune: 0, gain: 0.6, ...opts }
}

/** 构造音色配方 */
export function patch(layers: LayerSpec[], opts: Partial<Omit<SynthPatch, 'layers'>> = {}): SynthPatch {
  return {
    layers,
    fx: { ...DEFAULT_FX, ...(opts.fx ?? {}) },
    glide: opts.glide ?? 0,
    monophonic: opts.monophonic ?? false,
    velocitySensitivity: opts.velocitySensitivity ?? 0.45,
    polyphony: opts.polyphony ?? 16,
  }
}

/** 包络简写 */
export function env(a: number, d: number, s: number, r: number) {
  return { attack: a, decay: d, sustain: s, release: r }
}
