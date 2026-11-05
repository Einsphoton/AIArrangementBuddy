/**
 * 应用设置：AI 服务商、联网搜索、Agent 后端、音频与界面偏好。
 * 前后端共享同一份结构与默认值（服务端负责持久化到 data/settings.json）。
 */
import { z } from 'zod'

/** 服务商分组，用于设置页的「快捷配置」区分 */
export type ProviderPresetGroup = '推荐' | '国内直连' | '聚合网关' | '本地部署' | '其它'

export interface AiProviderPreset {
  id: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  hint: string
  group: ProviderPresetGroup
  /** 获取 Key 的页面 */
  docsUrl?: string
  /** 没拉取模型列表之前，给用户的可点击建议 */
  recommendedModels?: string[]
  /** 模型列表接口是公开的（不填 Key 也能拉到），用于自动预取 */
  publicModelList?: boolean
  /** 模型列表地址与推理地址不同时使用（如 OpenCode Go） */
  modelsUrl?: string
  /** 卡片角标，如「订阅制」「免费模型」 */
  tag?: string
  /** 一句话说明为什么选它 */
  blurb?: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  /* ---------------- 推荐：OpenCode 网关（聚合，一个 Key 用全部模型） ---------------- */
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'glm-5.3-flash',
    hint: '订阅制（Go $10/月），含 Kimi / GLM / DeepSeek / Qwen / MiniMax 等',
    group: '推荐',
    docsUrl: 'https://opencode.ai/docs/console/go/',
    recommendedModels: ['glm-5.3-flash', 'kimi-k3', 'deepseek-v4.1-flash', 'qwen3.8-flash', 'minimax-m3.1-flash'],
    publicModelList: true,
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',
    tag: '订阅制',
    blurb: '固定月费，模型质量高、价格低，适合长期写歌时大量调用',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'deepseek-v4.1-flash',
    hint: '按量付费网关，含 GPT-5.x / Claude / Gemini，还有一批免费模型',
    group: '推荐',
    docsUrl: 'https://opencode.ai/docs/zen/',
    recommendedModels: ['deepseek-v4.1-flash', 'gpt-5.4-mini', 'claude-sonnet-5', 'glm-5.3', 'deepseek-v4.1-flash-free'],
    publicModelList: true,
    tag: '有免费模型',
    blurb: '一个 Key 覆盖几乎所有主流模型，按量计费，想换模型随时点',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '性价比高，中文强，工具调用稳定',
    group: '推荐',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },

  /* ---------------- 国内直连 ---------------- */
  {
    id: 'qwen',
    name: '通义千问',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: '国内直连，工具调用可用',
    group: '国内直连',
    docsUrl: 'https://bailian.console.aliyun.com/',
    recommendedModels: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    hint: '超长上下文，适合贴整份乐谱分析',
    group: '国内直连',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    recommendedModels: ['moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    hint: '国内直连',
    group: '国内直连',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    recommendedModels: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  },

  /* ---------------- 聚合网关 ---------------- */
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '通用能力均衡',
    group: '聚合网关',
    docsUrl: 'https://platform.openai.com/api-keys',
    recommendedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    hint: '长文本与音乐描述能力出色',
    group: '聚合网关',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    recommendedModels: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest'],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    hint: '多模型聚合（国内访问快）',
    group: '聚合网关',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
    recommendedModels: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    hint: '一个 Key 用所有模型',
    group: '聚合网关',
    docsUrl: 'https://openrouter.ai/settings/keys',
    recommendedModels: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
    publicModelList: true,
  },

  /* ---------------- 本地部署 ---------------- */
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
    hint: '本地推理，完全离线，Key 随便填',
    group: '本地部署',
    docsUrl: 'https://ollama.com/download',
    recommendedModels: ['qwen2.5:14b', 'llama3.2', 'glm4:9b'],
  },

  /* ---------------- 其它 ---------------- */
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'your-model',
    hint: '任何兼容 /chat/completions 的服务（vLLM / LM Studio / one-api…）',
    group: '其它',
  },
]

export type AiProviderKind = 'openai' | 'anthropic'

export const aiProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['openai', 'anthropic']).default('openai'),
  baseUrl: z.string().default(''),
  /** 模型列表地址（留空则用 `${baseUrl}/models`） */
  modelsUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().min(256).max(200000).default(4096),
  /** 是否支持并行工具调用 */
  parallelToolCalls: z.boolean().default(true),
  /** 额外的请求头 */
  extraHeaders: z.record(z.string(), z.string()).default({}),
})
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>

export const searchProviderSchema = z.enum(['none', 'duckduckgo', 'tavily', 'brave', 'serper'])
export type SearchProviderId = z.infer<typeof searchProviderSchema>

export const searchConfigSchema = z.object({
  provider: searchProviderSchema.default('duckduckgo'),
  apiKey: z.string().default(''),
  /** 单次搜索返回条数 */
  maxResults: z.number().min(1).max(20).default(6),
})
export type SearchConfig = z.infer<typeof searchConfigSchema>

export const agentBackendSchema = z.enum(['builtin', 'codex', 'dsh'])
export type AgentBackendId = z.infer<typeof agentBackendSchema>

export const agentConfigSchema = z.object({
  backend: agentBackendSchema.default('builtin'),
  /** codex / dsh 可执行文件路径，留空则用 PATH 查找 */
  executablePath: z.string().default(''),
  /** Agent 工作目录（Codex 需要），留空则用 data/agent-workspace */
  workdir: z.string().default(''),
  /** 允许 Agent 联网搜索 */
  allowWebSearch: z.boolean().default(true),
  /** 允许 Agent 调用工具修改工程 */
  allowProjectEdits: z.boolean().default(true),
  /** codex 模型覆盖 */
  model: z.string().default(''),
  /** 单轮最长执行时间（毫秒） */
  timeoutMs: z.number().min(5000).max(600000).default(180000),
})
export type AgentConfig = z.infer<typeof agentConfigSchema>

export const audioSettingsSchema = z.object({
  masterVolume: z.number().min(0).max(1.5).default(0.9),
  /** 音色库文件路径（相对 /soundfonts 或绝对 URL） */
  soundfontUrl: z.string().default(''),
  /** 是否优先使用 SoundFont 引擎 */
  preferSoundfont: z.boolean().default(true),
  midiInputId: z.string().default(''),
  /** MIDI 输入延迟补偿（毫秒，可正可负） */
  midiLatencyMs: z.number().min(-200).max(400).default(0),
  /** 监听时是否直接发声 */
  midiThru: z.boolean().default(true),
})
export type AudioSettings = z.infer<typeof audioSettingsSchema>

export const uiSettingsSchema = z.object({
  theme: z.enum(['dark', 'midnight']).default('dark'),
  language: z.enum(['zh', 'en']).default('zh'),
  showGrid: z.boolean().default(true),
  showMinimap: z.boolean().default(true),
  /** 钢琴卷帘里音符默认力度 */
  defaultVelocity: z.number().min(1).max(127).default(96),
  scaleHighlight: z.boolean().default(true),
})
export type UiSettings = z.infer<typeof uiSettingsSchema>

export const appSettingsSchema = z.object({
  providers: z.array(aiProviderConfigSchema).default([]),
  activeProviderId: z.string().default(''),
  search: searchConfigSchema.default({ provider: 'duckduckgo', apiKey: '', maxResults: 6 }),
  agent: agentConfigSchema.default({
    backend: 'builtin',
    executablePath: '',
    workdir: '',
    allowWebSearch: true,
    allowProjectEdits: true,
    model: '',
    timeoutMs: 180000,
  }),
  audio: audioSettingsSchema.default({
    masterVolume: 0.9,
    soundfontUrl: '',
    preferSoundfont: true,
    midiInputId: '',
    midiLatencyMs: 0,
    midiThru: true,
  }),
  ui: uiSettingsSchema.default({
    theme: 'dark',
    language: 'zh',
    showGrid: true,
    showMinimap: true,
    defaultVelocity: 96,
    scaleHighlight: true,
  }),
})
export type AppSettings = z.infer<typeof appSettingsSchema>

export function defaultProviderFromPreset(presetId: string): AiProviderConfig {
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === presetId) ?? AI_PROVIDER_PRESETS[0]
  return {
    id: preset.id,
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    modelsUrl: preset.modelsUrl ?? '',
    apiKey: '',
    model: preset.model,
    temperature: 0.7,
    maxTokens: 4096,
    parallelToolCalls: true,
    extraHeaders: {},
  }
}

export function createDefaultSettings(): AppSettings {
  const deepseek = defaultProviderFromPreset('deepseek')
  return {
    providers: [deepseek],
    activeProviderId: deepseek.id,
    search: { provider: 'duckduckgo', apiKey: '', maxResults: 6 },
    agent: {
      backend: 'builtin',
      executablePath: '',
      workdir: '',
      allowWebSearch: true,
      allowProjectEdits: true,
      model: '',
      timeoutMs: 180000,
    },
    audio: {
      masterVolume: 0.9,
      soundfontUrl: '',
      preferSoundfont: true,
      midiInputId: '',
      midiLatencyMs: 0,
      midiThru: true,
    },
    ui: {
      theme: 'dark',
      language: 'zh',
      showGrid: true,
      showMinimap: true,
      defaultVelocity: 96,
      scaleHighlight: true,
    },
  }
}

/** 脱敏：接口返回给前端时隐藏完整 Key */
export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}
