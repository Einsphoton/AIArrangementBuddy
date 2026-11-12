/**
 * 本机 AI 引擎的「发行清单」（P8）。
 *
 * 目标：Mac / Windows / Linux 上都能只靠代码 + 网络自动装好：
 *   - ACE-Step 运行时（Windows 用上游 modern 预编译 + NVIDIA CUDA 13 redist；
 *     Mac/Linux 沿用官方 GitHub release 的 legacy 归档）
 *   - 模型（公开 HuggingFace 仓库，LFS sha256 校验）
 *   - LoRA 适配器（发布到本仓库 GitHub Releases；真实数据内部研究版不在此列）
 *
 * 所有大小/sha256 都是**钉死**的；下载后逐一校验，避免半包/投毒。
 */

export type ProvisionPlatform = 'win32-x64' | 'darwin-arm64' | 'linux-x64'
export type ProvisionProfile = 'essential' | 'quality' | 'stems' | 'xl'

/** 运行时 API 版本：modern = 上游 acestep.cpp 预编译（支持 XL 4B）；legacy = 官方 v0.1.0 归档 */
export type RuntimeApi = 'legacy' | 'modern'

export interface RuntimeAsset {
  platform: ProvisionPlatform
  /** release 文件名 */
  archive: string
  format: 'zip' | 'tar.gz'
  size: number
  /** 已知哈希（mac/windows 已实测；linux 暂缺，靠 size 校验） */
  sha256?: string
}

/** 对外展示的运行时版本号（内部打包名不暴露给用户；真实版本仍用于校验与升级） */
export const ENGINE_RUNTIME_VERSION = '1.0.0'

/** 官方 ACE-Step 运行时 release（ace-step/acestep.vst3，legacy；仅 Mac/Linux 继续使用） */
export const ACESTEP_RELEASE_TAG = 'v0.1.0'
export const ACESTEP_RELEASE_BASE = `https://github.com/ace-step/acestep.vst3/releases/download/${ACESTEP_RELEASE_TAG}`

/**
 * legacy 归档清单（Mac/Linux 安装用）。
 * Windows 已改用下面的 modern 运行时（逐文件下载）；此处的 win32 项只为旧版本兼容保留。
 */
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

/* ------------------------------------------------------------------ */
/* modern 运行时（Windows x64）：上游 acestep.cpp 2026-11-06 预编译     */
/* ------------------------------------------------------------------ */

/** modern 运行时版本号（写进 runtime.json.version / provisionStatus.runtime.version） */
export const RUNTIME_VERSION = 'acestep.cpp-20261106'

/** modern 运行时文件下载 URL base（所有文件同源，下载到 <dataDir>/ace-step/ 根目录） */
export const MODERN_RUNTIME_BASE = 'https://www.serveurperso.com/temp/acestep.cpp-win64/build/Release/'

/** modern 运行时单个文件（逐文件钉 size + sha256） */
export interface RuntimeFile {
  name: string
  size: number
  sha256: string
}

/** modern Windows 运行时文件（24 个） */
export const MODERN_RUNTIME_FILES: RuntimeFile[] = [
  { name: 'ace-lm.exe', size: 422_912, sha256: '009ac2d8f8b39a75a4114951f86198ec97746cfc9f1ee1349345d63078772e89' },
  { name: 'ace-server.exe', size: 1_431_552, sha256: 'b05ed4e8dd7efeb08640bae505e919a3c9cab4357b76af306d2993460bb0806d' },
  { name: 'ace-synth.exe', size: 645_632, sha256: '3cea88b5704fdb893d8e473856d93f79567f628ccf68f188eb902166b4e4200b' },
  { name: 'ace-understand.exe', size: 442_368, sha256: '31e2f0ab67554401c3254880d0528e8c4a7a59d12080d1ac6e40a81779892532' },
  { name: 'ggml-base.dll', size: 716_800, sha256: '94bed403dd00bb7db7e859bbfb1c4db0766eda02c870eda6dd325aef5e9cd5da' },
  { name: 'ggml-cpu-alderlake.dll', size: 997_888, sha256: '8b2afc4d2ed6fe67424952b7cdffd3e24a80bb93553eaec14158556d49829549' },
  { name: 'ggml-cpu-cannonlake.dll', size: 1_039_360, sha256: 'd59b91fc76bf524985777d89515df8e29c7e1bb764d8ca48cecab559dc2f9c0d' },
  { name: 'ggml-cpu-cascadelake.dll', size: 1_053_184, sha256: '7553fd4218fa94f25682dbe16a50f6cac54227963cad89cb029fbdc05abb8af3' },
  { name: 'ggml-cpu-haswell.dll', size: 998_912, sha256: 'd89a6804b1f180d05b1e4322c81c775ca14d8213e9a8834fcdf18dd07eb682ad' },
  { name: 'ggml-cpu-icelake.dll', size: 1_053_184, sha256: '551661482d4e8e6a044c9b5e6a9e211aece3d0b6fdaab0c332f46be1fddd762d' },
  { name: 'ggml-cpu-sandybridge.dll', size: 1_046_528, sha256: '5067cb64cf4d6d300ccfe7ba8536645bceea0fe67752357df91afed784cf99bc' },
  { name: 'ggml-cpu-skylakex.dll', size: 1_039_360, sha256: '7e6f99246c4fe282c30a6288230ccd7d934bebb4c3e890f20e284c3a68e19d45' },
  { name: 'ggml-cpu-sse42.dll', size: 882_688, sha256: 'ec04ffb977aa786a99239f5a8bfb34482c45cd9ac47557fea67ffc2d1f9a828a' },
  { name: 'ggml-cpu-x64.dll', size: 886_272, sha256: '977bddca01179b0cfe777da33b622d7e5a4b9d2c8881ca7bcc904891481336ea' },
  { name: 'ggml-cuda.dll', size: 137_519_104, sha256: '6d138427fd8676a5ad8eba33d1001ae402a457e3a33bfd174590f6199878249a' },
  { name: 'ggml-vulkan.dll', size: 41_986_048, sha256: 'cd88ab17d7ab5d104a6e38f4feb06a8fd0eff3b8ff01ac41c859074de1dec9bd' },
  { name: 'ggml.dll', size: 61_440, sha256: '34ef1d8b3f0dc891b85c397653a722af0ba844921d25a7721d5c81eb0f157b05' },
  { name: 'mp3-codec.exe', size: 111_616, sha256: '36caf117fa31b42a16ff00eb4518868620b328b593c9285a08a507559a6d5672' },
  { name: 'neural-codec.exe', size: 187_392, sha256: '1287075ada5f3ea82b1067ccf89163e06bee706e684bae775a4d65d954e1f2c7' },
  { name: 'quantize.exe', size: 20_992, sha256: '7bf64173d05a85e0f364981af1938f0866e8a3cec0f3b4442a590eeb6c1fbbf7' },
  { name: 'test-lm-prompt.exe', size: 103_424, sha256: 'e5ac93e99ed9a24d6b675edaa4d70671426e084322605959185657db819762e4' },
  { name: 'test-model-store.exe', size: 169_984, sha256: '91b310fdf6b06b4d43bb8c78d1761d47b630a1605ef581f8d9c42aab0afa4adf' },
  { name: 'test-philox.exe', size: 14_848, sha256: '2b7ace104ea4965f9bfc887a6d24a41ace292c7f0b2936316d8e987aab0566d5' },
  { name: 'vulkan-shaders-gen.exe', size: 312_832, sha256: '25b5494a81e4679505373cc64505b1c9a524b7ce3e72b2e9adc8cec66026ec87' },
]

/** CUDA 13 redist 组件（modern Windows 必需）：下载 zip 后按前缀取出 DLL 放到运行时根目录 */
export interface CudaRedistAsset {
  /** 下载缓存文件名（.downloads/ 下） */
  archive: string
  url: string
  size: number
  sha256: string
  /** 需要提取的 DLL 文件名（按 zip 内 basename 前缀匹配） */
  dllNames: string[]
}

export const CUDA_REDIST_ASSETS: CudaRedistAsset[] = [
  {
    archive: 'cuda_cudart-windows-x86_64-13.0.48-archive.zip',
    url: 'https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-13.0.48-archive.zip',
    size: 2_873_274,
    sha256: '82fb29001895810ce02e88b180cbaa90607b852a7f67a63f18f202079eaa2966',
    dllNames: ['cudart64_13.dll'],
  },
  {
    archive: 'libcublas-windows-x86_64-13.0.0.19-archive.zip',
    url: 'https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-13.0.0.19-archive.zip',
    size: 399_809_469,
    sha256: 'c8fb12715b9639f51983315cc4b195e272128c675aa3766b13c4f470b892e6c8',
    dllNames: ['cublas64_13.dll', 'cublasLt64_13.dll'],
  },
]

/** NVIDIA 驱动自带的 hybrid CUDA runtime（不随 redist 分发，安装时从 DriverStore 复制；缺失仅告警） */
export const NVCUDART_HYBRID_DLL = 'nvcudart_hybrid64.dll'

export function modernRuntimeUrl(file: RuntimeFile): string {
  return `${MODERN_RUNTIME_BASE}${file.name}`
}

/** 平台默认运行时 API：Windows x64 用 modern，其它平台沿用 legacy 归档 */
export function runtimeApiForPlatform(platform: ProvisionPlatform): RuntimeApi {
  return platform === 'win32-x64' ? 'modern' : 'legacy'
}

/** 运行时安装计划版本：modern 用上游构建号；legacy 用官方归档名 */
export function runtimePlanVersion(platform: ProvisionPlatform): string {
  return platform === 'win32-x64' ? RUNTIME_VERSION : RUNTIME_ASSETS[platform].archive
}

/** 运行时安装计划需要下载的字节数（modern 含 24 个文件 + 2 个 CUDA zip） */
export function runtimePlanBytes(platform: ProvisionPlatform): number {
  if (platform === 'win32-x64') {
    return MODERN_RUNTIME_FILES.reduce((sum, file) => sum + file.size, 0) + CUDA_REDIST_ASSETS.reduce((sum, asset) => sum + asset.size, 0)
  }
  return RUNTIME_ASSETS[platform].size
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
  /* P9：XL（4B）模型档；只有 modern 运行时（Windows）才真正可用 */
  {
    name: 'acestep-v15-xl-turbo-Q8_0.gguf',
    path: 'acestep-v15-xl-turbo-Q8_0.gguf',
    size: 5_305_828_736,
    sha256: '4f1044fb646374fb5730e10f64325766883eb2fc02a643c1b403f2d61f39dc19',
    profiles: ['xl'],
  },
  {
    name: 'acestep-v15-xl-sft-Q8_0.gguf',
    path: 'acestep-v15-xl-sft-Q8_0.gguf',
    size: 5_305_828_704,
    sha256: 'd7b06fadab214375ef5ebcfa44bf4a10489ea364b119f5b9ecbcd870408bdab9',
    profiles: ['xl'],
  },
  {
    name: 'acestep-v15-xl-base-Q8_0.gguf',
    path: 'acestep-v15-xl-base-Q8_0.gguf',
    size: 5_305_828_704,
    sha256: '45d05b88ccbfa0ea27208ea618d7f0749b2be040b457cfa661d37646ea39f207',
    profiles: ['xl'],
  },
  {
    name: 'acestep-5Hz-lm-4B-Q8_0.gguf',
    path: 'acestep-5Hz-lm-4B-Q8_0.gguf',
    size: 4_457_323_648,
    sha256: '972f91147a167f0c041f1b158d67985a82c0f6a852e68cdf70e46030cf08b1bc',
    profiles: ['xl'],
  },
]

/** 各 profile 实际包含的文件（essential 必须最先装；quality/stems/xl 可选叠加） */
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
    case 'xl':
      return '增强版最佳质量（快速/精修/分轨增强模型，需 ≥12GB 显存）'
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

/** 本机 AI 音频生成引擎根目录（在数据目录下，随产品数据走） */
export const PROVISION_DIR_NAME = 'audio-engine'
/** 旧版目录名（仅用于自动迁移；迁移后界面/接口只显示新名字） */
export const LEGACY_PROVISION_DIR_NAME = 'ace-step'
/** 下载缓存（支持断点续传） */
export const DOWNLOAD_CACHE_DIR = '.downloads'