/**
 * 本机 AI 引擎的「发行清单」（P8）。
 *
 * 目标：Mac / Windows / Linux 上都能只靠代码 + 网络自动装好：
 *   - ACE-Step 运行时（官方 GitHub release 的多平台二进制）
 *   - 模型（公开 HuggingFace 仓库，LFS sha256 校验）
 *   - LoRA 适配器（发布到本仓库 GitHub Releases；真实数据内部研究版不在此列）
 *
 * 所有大小/sha256 都是**钉死**的；下载后逐一校验，避免半包/投毒。
 */

export type ProvisionPlatform = 'win32-x64' | 'darwin-arm64' | 'linux-x64'
export type ProvisionProfile = 'essential' | 'quality' | 'stems'

export interface RuntimeAsset {
  platform: ProvisionPlatform
  /** release 文件名 */
  archive: string
  format: 'zip' | 'tar.gz'
  size: number
  /** 已知哈希（mac/windows 已实测；linux 暂缺，靠 size 校验） */
  sha256?: string
}

/** 对外展示的运行时版本号（内部打包名不暴露给用户） */
export const ENGINE_RUNTIME_VERSION = '1.0.0'

/** 官方 ACE-Step 运行时 release（ace-step/acestep.vst3） */
export const ACESTEP_RELEASE_TAG = 'v0.1.0'
export const ACESTEP_RELEASE_BASE = `https://github.com/ace-step/acestep.vst3/releases/download/${ACESTEP_RELEASE_TAG}`

export const RUNTIME_ASSETS: Record<ProvisionPlatform, RuntimeAsset> = {
  'win32-x64': {
    platform: 'win32-x64',
    archive: 'acestep-windows-x64.zip',
    format: 'zip',
    size: 137_805_556,
    sha256: '636f1d9bb7b8966f0a0c35dfad0f19edb122cb6e79f7d9a00232f4b51e7b4108',
  },
  'darwin-arm64': {
    platform: 'darwin-arm64',
    archive: 'acestep-macos-arm64-metal.tar.gz',
    format: 'tar.gz',
    size: 2_502_371,
    sha256: '8c94952e21a2615c98a7c9d79230d62bae5d9692adc36d12a5d8e4597ec849da',
  },
  'linux-x64': {
    platform: 'linux-x64',
    archive: 'acestep-linux-x64.tar.gz',
    format: 'tar.gz',
    size: 141_878_959,
  },
}

/** 运行时解压后可能的二进制相对路径（官方包是扁平结构） */
export const RUNTIME_BINARIES = {
  win32: ['ace-server.exe', 'bin/ace-server.exe'],
  darwin: ['ace-server', 'bin/ace-server'],
  linux: ['ace-server', 'bin/ace-server'],
} as const

/** macOS 包里的二进制/工具（用于 chmod +x） */
export const RUNTIME_EXECUTABLES = [
  'ace-server',
  'ace-lm',
  'ace-synth',
  'ace-understand',
  'quantize',
  'neural-codec',
  'mp3-codec',
]

/** 公开模型仓库（ACE-Step 1.5 GGUF，含各量化档） */
export const HF_REPO = 'Serveurperso/ACE-Step-1.5-GGUF'
export const HF_BASE = 'https://huggingface.co'
export const HF_RESOLVE_BASE = `${HF_BASE}/${HF_REPO}/resolve/main`

export interface ModelFile {
  /** 本地文件名（运行时按这个找） */
  name: string
  /** HF 仓库内路径 */
  path: string
  size: number
  /** LFS oid = 文件 sha256 */
  sha256: string
  /** 哪些 profile 需要它 */
  profiles: ProvisionProfile[]
}

export const MODEL_FILES: ModelFile[] = [
  {
    name: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    path: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    size: 784_144_960,
    sha256: '972f23255e46adfe744a0eb9a0039f3c63988f65753b0968d776e8b27168c321',
    profiles: ['essential'],
  },
  {
    name: 'vae-BF16.gguf',
    path: 'vae-BF16.gguf',
    size: 337_420_928,
    sha256: '0599862ac5d15cd308e1d2e368373aea6c02e25ebd1737ad4a4562a0901b0ef8',
    profiles: ['essential'],
  },
  {
    name: 'acestep-v15-turbo-Q8_0.gguf',
    path: 'acestep-v15-turbo-Q8_0.gguf',
    size: 2_549_528_000,
    sha256: '288f708a61cfc241013a98a62f98ba331f83fe34d0d3559acdd9b0f6a2f7cd6b',
    profiles: ['essential'],
  },
  {
    name: 'acestep-v15-sft-Q8_0.gguf',
    path: 'acestep-v15-sft-Q8_0.gguf',
    size: 2_549_527_936,
    sha256: '17f1984e48aaab27b3eb8ccbf0b754a6656e677884c60ea7003845cfc0059b70',
    profiles: ['quality'],
  },
  {
    name: 'acestep-5Hz-lm-1.7B-Q8_0.gguf',
    path: 'acestep-5Hz-lm-1.7B-Q8_0.gguf',
    size: 1_975_837_568,
    sha256: '726f99a82f050b32ebc5c5e36acaa9d7acd06bfe5e579a62b00e0d0d6d0b7ec6',
    profiles: ['quality'],
  },
  {
    name: 'acestep-v15-base-Q8_0.gguf',
    path: 'acestep-v15-base-Q8_0.gguf',
    size: 2_549_527_936,
    sha256: '10329f321010cedc3571c24b6371d002ce49238f48be47def4a1c76bf27ee150',
    profiles: ['stems'],
  },
]

/** 各 profile 实际包含的文件（essential 必须最先装；quality/stems 可选叠加） */
export function modelsForProfiles(profiles: ProvisionProfile[]): ModelFile[] {
  const wanted = new Set<ProvisionProfile>()
  for (const profile of profiles) {
    if (profile === 'essential') {
      wanted.add('essential')
    } else {
      wanted.add('essential')
      wanted.add(profile)
    }
  }
  return MODEL_FILES.filter((file) => file.profiles.some((profile) => wanted.has(profile)))
}

export function resolvePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProvisionPlatform {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  throw new Error(
    `不支持的平台：${platform}/${arch}。当前自动安装支持 Windows x64 / macOS Apple Silicon / Linux x64；` +
      `其他平台请自行编译 AI 音频生成引擎运行时，并把 AIAB_ENGINE_DIR 指向其目录`,
  )
}

export function runtimeUrl(platform: ProvisionPlatform): string {
  return `${ACESTEP_RELEASE_BASE}/${RUNTIME_ASSETS[platform].archive}`
}

export function modelUrl(file: ModelFile): string {
  return `${HF_RESOLVE_BASE}/${file.path}`
}

export function profileLabel(profile: ProvisionProfile): string {
  switch (profile) {
    case 'essential':
      return '基础能力（快速生成模式）'
    case 'quality':
      return '质量增强（精修生成 + 提示词增强）'
    case 'stems':
      return '分轨能力（分轨生成模式）'
  }
}

/* ------------------------------------------------------------------ */
/* LoRA 适配器（P8-B）：只发布自生成数据的适配器                        */
/* ------------------------------------------------------------------ */

export interface AdapterAsset {
  id: string
  name: string
  style?: string
  license: string
  file: string
  size: number
  sha256: string
}

/**
 * 发布在本仓库 GitHub Releases 的适配器（adapters-v1）。
 * 只包含自生成数据训练的版本；真实录音内部研究版（real_*）永远不在此列。
 */
export const ADAPTER_RELEASE_TAG = 'adapters-v1'
export const ADAPTER_RELEASE_BASE = `https://github.com/Einsphoton/AIArrangementBuddy/releases/download/${ADAPTER_RELEASE_TAG}`

export const ADAPTER_ASSETS: AdapterAsset[] = [
  {
    id: 'jrpg_v1',
    name: 'JRPG v1',
    style: 'jrpg',
    license: 'self-generated (ACE-Step 1.5 MIT weights); no third-party rights',
    file: 'adapter-jrpg_v1.tar.gz',
    size: 17_108_566,
    sha256: 'f07c710cdee5d49ffde4063a81154e197e3ad028da1d310077eff03cce5b27dd',
  },
  {
    id: 'jrpg_v2',
    name: 'JRPG v2',
    style: 'jrpg',
    license: 'self-generated (ACE-Step 1.5 MIT weights); no third-party rights',
    file: 'adapter-jrpg_v2.tar.gz',
    size: 34_142_622,
    sha256: '42116497b5d383215935255f7ee027ce824c2a3db5d0b6f9b8befc85bb59c1b1',
  },
  {
    id: 'jrock_v1',
    name: 'J-Rock v1',
    style: 'jrock',
    license: 'self-generated (ACE-Step 1.5 MIT weights); no third-party rights',
    file: 'adapter-jrock_v1.tar.gz',
    size: 34_110_127,
    sha256: '14859aafd442ba90b9cba5685c9d78024f080af1c501342c93cfd407827b3d47',
  },
]

export function adapterUrl(asset: AdapterAsset): string {
  return `${ADAPTER_RELEASE_BASE}/${asset.file}`
}

export function adaptersTotalBytes(assets: AdapterAsset[] = ADAPTER_ASSETS): number {
  return assets.reduce((sum, asset) => sum + asset.size, 0)
}

/** 本机 agent 引擎根目录（在数据目录下，随产品数据走） */
export const PROVISION_DIR_NAME = 'audio-engine'
/** 旧版目录名（仅用于自动迁移；迁移后界面只显示新名字） */
export const LEGACY_PROVISION_DIR_NAME = 'ace-step'
/** 下载缓存（支持断点续传） */
export const DOWNLOAD_CACHE_DIR = '.downloads'