/**
 * P10-B 验收：服务器离线包 + 镜像分发 API（离线、无外网）。
 *
 *   node scripts/verify-engine-package.mjs
 *
 * 覆盖：
 * - enginePackage：buildEnginePackage 从伪造的已安装目录（稀疏文件，size 与清单钉死值一致）
 *   打包 essential+xl+训练数据 → 校验 manifest 文件数/key/file 布局/sha256/硬链接计数/进度；
 *   文件缺失时跳过并汇总 warnings；readEnginePackage 读回；
 * - findLocalArtifact：离线包优先于已安装目录缓存、未知/穿越 key 返回 null、自定义包目录；
 * - copyLocalArtifact：硬链接/复制成功、sha256 不符删除 dest 返回 false、size 不符 false、Abort 抛 AbortError；
 * - P11：createTarGz（ustar/gzip 写入）往返 + 非法路径拒绝；适配器只有已解压目录（无 .downloads 归档）时
 *   buildEnginePackage 回打 adapters/<file>.tar.gz（manifest 用实际 size/sha256）且安装器解压语义一致；
 * - listMirrorFiles / resolveMirrorFile：package+cache 合并、training=false 过滤、目录穿越全拒；
 * - HTTP 路由（Fastify inject，临时 DATA_DIR）：status.download 字段、mirror manifest 开启/关闭/令牌、
 *   file Range 206 / HEAD / 416 / 401 / 404、sources 配置与（可选）探测、package build 异步任务；
 * - routes/training 仍可访问（接线不破坏 P8-C 路由）。
 *
 * 说明：假文件用「写 0 字节再 truncate」创建，只保证 size 与清单一致（不占实际磁盘）；
 * 因此 buildEnginePackage 只校验 size（manifest 里写钉死 sha256），copyLocalArtifact 才校验 sha256。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ */
/* 进程内 TS 加载器（与 verify_provision.mjs 一致：.js → .ts）           */
/* ------------------------------------------------------------------ */

process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning') return
  console.warn(warning?.stack ?? String(warning))
})

function installTsLoader() {
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
        const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd()
        const candidate = path.resolve(base, `${specifier.slice(0, -3)}.ts`)
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.ts')) {
        const file = fileURLToPath(url)
        const source = readFileSync(file, 'utf8')
        const output = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: file,
        }).outputText
        return { format: 'module', source: output, shortCircuit: true }
      }
      return nextLoad(url, context)
    },
  })
}

installTsLoader()

const TMP = mkdtempSync(path.join(tmpdir(), 'aiab-engine-package-'))
const DATA_A = path.join(TMP, 'data-a')
const DATA_B = path.join(TMP, 'data-b')
const DATA_C = path.join(TMP, 'data-c')
/** P11：只有已解压适配器目录（无 .downloads 归档）/ 归档与解压目录并存 */
const DATA_D = path.join(TMP, 'data-d')
const DATA_E = path.join(TMP, 'data-e')
/** 路由测试固定用 DATA_A（config.ts 在 import 时读 DATA_DIR） */
process.env.DATA_DIR = DATA_A
process.env.LOG_LEVEL = 'error'
for (const name of [
  'AIAB_ENGINE_PACKAGE_DIR',
  'AIAB_MIRROR_TOKEN',
  'AIAB_SERVER_ASSIST',
  'AIAB_SERVER_ASSIST_URL',
  'AIAB_HF_MIRROR',
  'AIAB_GITHUB_MIRROR',
  'AIAB_RUNTIME_MIRROR',
  'AIAB_DOWNLOAD_CONCURRENCY',
  'AIAB_DOWNLOAD_STRATEGY',
  'AIAB_SOURCE_PROBE_TIMEOUT_MS',
]) {
  delete process.env[name]
}

const engine = await import('../apps/server/src/provision/enginePackage.ts')
const manifest = await import('../apps/server/src/provision/manifest.ts')
const trainingManifest = await import('../apps/server/src/provision/trainingManifest.ts')
const tarWriter = await import('../apps/server/src/provision/tarWriter.ts')
const untar = await import('../apps/server/src/provision/untar.ts')
const { buildServer } = await import('../apps/server/src/index.ts')

/** CLI 纯函数（scripts/provision.mjs 有 isMain 保护，被 import 时不会执行 CLI 主流程） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const provisionCli = await import(pathToFileURL(path.join(ROOT, 'scripts', 'provision.mjs')).href)
const { buildFetchedRuntimeRecord, writeFetchedRuntimeManifest } = provisionCli

const {
  ENGINE_PACKAGE_MANIFEST,
  buildEnginePackage,
  copyLocalArtifact,
  enginePackageDir,
  findLocalArtifact,
  listMirrorFiles,
  parseEngineKey,
  readEnginePackage,
  resolveMirrorFile,
} = engine
const { MODERN_RUNTIME_FILES, CUDA_REDIST_ASSETS, RUNTIME_ASSETS, MODEL_FILES, ADAPTER_ASSETS, RUNTIME_VERSION, ENGINE_RUNTIME_VERSION, PROVISION_DIR_NAME, modelsForProfiles, resolvePlatform } = manifest
const {
  TRAINING_CODE,
  TRAINING_DATASETS,
  TRAINING_CHECKPOINTS,
  TRAINING_PYTHON,
} = trainingManifest
const { createTarGz } = tarWriter
const { extractTarGz, extractTarGzFileToDir } = untar

const PLATFORM = resolvePlatform()
const TRAINING_PLATFORM = process.platform === 'darwin' ? 'darwin-arm64' : process.platform === 'win32' ? 'win32-x64' : 'linux-x64'
const PYTHON_ASSET = TRAINING_PYTHON[TRAINING_PLATFORM]
const GB = 1e9

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    const detail = await fn()
    passed++
    console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}  ${error.message}`)
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const assertEqual = (actual, expected, label) => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${label}：期望 ${right}，实际 ${left}`)
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 稀疏文件：只占 size，不占实际磁盘（与 verify_provision.mjs 相同做法） */
function writeSparseFile(target, size) {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, '')
  truncateSync(target, size)
}

function writeSettings(dataDir, provision) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ provision }, null, 2), 'utf8')
}

/** 期望的离线包 key → { size, sha256 }（由清单钉死值生成） */
function expectedArtifacts(profiles, includeTraining) {
  const out = new Map()
  if (PLATFORM === 'win32-x64') {
    for (const file of MODERN_RUNTIME_FILES) out.set(`runtime/${file.name}`, { size: file.size, sha256: file.sha256 })
    for (const asset of CUDA_REDIST_ASSETS) out.set(`cuda/${asset.archive}`, { size: asset.size, sha256: asset.sha256 })
  } else {
    const asset = RUNTIME_ASSETS[PLATFORM]
    out.set(`runtime-archive/${asset.archive}`, { size: asset.size, sha256: asset.sha256 })
  }
  for (const file of modelsForProfiles(profiles)) out.set(`model/${file.name}`, { size: file.size, sha256: file.sha256 })
  for (const asset of ADAPTER_ASSETS) out.set(`adapter/${asset.file}`, { size: asset.size, sha256: asset.sha256 })
  if (includeTraining) {
    out.set('training/code', { size: TRAINING_CODE.size, sha256: TRAINING_CODE.sha256 })
    out.set('training/python', { size: PYTHON_ASSET.size, sha256: PYTHON_ASSET.sha256 })
    for (const dataset of TRAINING_DATASETS) out.set(`training/dataset/${dataset.id}`, { size: dataset.size, sha256: dataset.sha256 })
    for (const file of TRAINING_CHECKPOINTS) out.set(`training/checkpoint/${file.dest}`, { size: file.size, sha256: file.sha256 })
  }
  return out
}

/** 在 dataDir 里伪造「已安装引擎 + 训练下载缓存」 */
function createInstalledFixture(dataDir, options = {}) {
  const { omitRuntime = [], omitModels = [], omitAdapters = false, training = false } = options
  const ace = path.join(dataDir, PROVISION_DIR_NAME)
  if (PLATFORM === 'win32-x64') {
    for (const file of MODERN_RUNTIME_FILES) {
      if (omitRuntime.includes(file.name)) continue
      writeSparseFile(path.join(ace, file.name), file.size)
    }
    for (const asset of CUDA_REDIST_ASSETS) writeSparseFile(path.join(ace, '.downloads', asset.archive), asset.size)
  } else {
    const asset = RUNTIME_ASSETS[PLATFORM]
    writeSparseFile(path.join(ace, '.downloads', asset.archive), asset.size)
  }
  for (const file of modelsForProfiles(['essential', 'xl'])) {
    if (omitModels.includes(file.name)) continue
    writeSparseFile(path.join(ace, 'models', file.name), file.size)
  }
  if (!omitAdapters) {
    for (const asset of ADAPTER_ASSETS) writeSparseFile(path.join(ace, '.downloads', asset.file), asset.size)
  }
  if (training) {
    const root = path.join(dataDir, 'training')
    writeSparseFile(path.join(root, '.downloads', TRAINING_CODE.file), TRAINING_CODE.size)
    writeSparseFile(path.join(root, '.downloads', PYTHON_ASSET.file), PYTHON_ASSET.size)
    for (const dataset of TRAINING_DATASETS) writeSparseFile(path.join(root, '.downloads', dataset.file), dataset.size)
    for (const file of TRAINING_CHECKPOINTS) writeSparseFile(path.join(root, 'checkpoints', ...file.dest.split('/')), file.size)
  }
  return ace
}

/**
 * 伪造「已解压安装的 LoRA 适配器」：`<dataDir>/adapters/<id>/{adapter.json, adapter_config.json,
 * adapter_model.safetensors}`（真实机器上安装完成后通常只剩这个目录，`.downloads` 归档被清理）。
 */
function writeExtractedAdapters(dataDir) {
  const root = path.join(dataDir, 'adapters')
  for (const asset of ADAPTER_ASSETS) {
    const base = path.join(root, asset.id)
    mkdirSync(base, { recursive: true })
    writeFileSync(
      path.join(base, 'adapter.json'),
      JSON.stringify({ id: asset.id, name: asset.name, baseModel: 'acestep-v15-turbo', rank: 8 }, null, 2),
      'utf8',
    )
    writeFileSync(path.join(base, 'adapter_config.json'), JSON.stringify({ r: 8, alpha: 16 }, null, 2), 'utf8')
    writeFileSync(path.join(base, 'adapter_model.safetensors'), Buffer.alloc(2048, (asset.id.charCodeAt(0) % 251) + 1))
  }
  return root
}

/** 一个带真实内容的小离线包（用来验证 package 优先 + copyLocalArtifact 正常成功） */function createSmallPackage(dataDir) {
  const packageDir = path.join(dataDir, 'engine-package')
  mkdirSync(packageDir, { recursive: true })
  const content = Buffer.from('P10-B offline package tiny model payload\n'.repeat(64))
  const modelName = 'vae-BF16.gguf'
  const relative = 'models/tiny.gguf'
  mkdirSync(path.join(packageDir, 'models'), { recursive: true })
  writeFileSync(path.join(packageDir, ...relative.split('/')), content)
  const manifestData = {
    schema: 1,
    createdAt: new Date().toISOString(),
    platform: PLATFORM,
    label: 'tiny-package',
    files: [{ key: `model/${modelName}`, kind: 'model', file: relative, size: content.length, sha256: sha256(content) }],
  }
  writeFileSync(path.join(packageDir, ENGINE_PACKAGE_MANIFEST), JSON.stringify(manifestData, null, 2))
  return { packageDir, content, modelName, relative }
}

/** 路由令牌：header 与 query 两种 */
function authHeaders(token) {
  return token ? { 'x-aiab-mirror-token': token } : {}
}

try {
  console.log(`\nP10-B/P11 服务器离线包 + 镜像分发 + LoRA 回打验收（平台 ${PLATFORM}）\n`)

  /* ---------------- 1. 构建离线包（完整：essential + xl + 训练数据） ---------------- */
  createInstalledFixture(DATA_A, { training: true })
  // 伪造已装运行时的 runtime.json（mirror manifest 的 runtime 摘要来源）
  const serverRuntimeRecord =
    PLATFORM === 'win32-x64'
      ? { api: 'modern', version: RUNTIME_VERSION, platform: PLATFORM }
      : { api: 'legacy', version: RUNTIME_ASSETS[PLATFORM].archive, platform: PLATFORM }
  writeFileSync(path.join(DATA_A, PROVISION_DIR_NAME, 'runtime.json'), JSON.stringify(serverRuntimeRecord, null, 2))
  const expected = expectedArtifacts(['essential', 'xl'], true)
  const progress = []
  const built = await buildEnginePackage({
    dataDir: DATA_A,
    profiles: ['essential', 'xl'],
    includeTraining: true,
    onProgress: (value, message) => progress.push({ value, message }),
  })

  await check('buildEnginePackage：文件数/key/包内布局与清单钉死值一致', () => {
    assertEqual(built.dir, path.join(DATA_A, 'engine-package'), '包目录 = <dataDir>/engine-package')
    assertEqual(built.manifest.schema, 1, 'manifest schema')
    assertEqual(built.manifest.platform, PLATFORM, 'manifest platform')
    assert(built.manifest.files.length === expected.size, `文件数=${built.manifest.files.length}，期望 ${expected.size}`)
    const keys = built.manifest.files.map((file) => file.key)
    assertEqual(new Set(keys).size, keys.length, 'key 不重复')
    for (const [key, meta] of expected) {
      const entry = built.manifest.files.find((file) => file.key === key)
      assert(entry, `缺 key ${key}`)
      assertEqual(entry.size, meta.size, `${key} size`)
      if (meta.sha256) assertEqual(entry.sha256, meta.sha256, `${key} sha256 必须用清单钉死值`)
      assert(entry.file && !entry.file.startsWith('/') && !entry.file.includes('..'), `${key} file 相对路径非法：${entry.file}`)
    }
    const fileLayouts = [
      ['runtime/ace-server.exe', 'runtime/ace-server.exe'],
      ['model/', 'models/'],
      ['cuda/', 'cuda/'],
      ['adapter/', 'adapters/'],
      ['training/code', 'training/code/'],
      ['training/checkpoint/', 'training/checkpoints/'],
    ]
    for (const [prefix, expectedPrefix] of fileLayouts) {
      const entry = built.manifest.files.find((file) => file.key.startsWith(prefix) || file.key === prefix)
      if (!entry) continue
      assert(entry.file.startsWith(expectedPrefix), `${entry.key} 包内路径 ${entry.file} 应以 ${expectedPrefix} 开头`)
    }
    return `${built.manifest.files.length} 个文件 / ${(built.bytes / GB).toFixed(2)}GB（key/sha/file 全对）`
  })

  await check('buildEnginePackage：文件真的落到包目录、readEnginePackage 可读回', () => {
    const manifestPath = path.join(built.dir, ENGINE_PACKAGE_MANIFEST)
    assert(existsSync(manifestPath), '缺少 engine-package.json')
    const reread = readEnginePackage(DATA_A)
    assert(reread, 'readEnginePackage 返回 null')
    assertEqual(reread.dir, built.dir, '读回 dir')
    assertEqual(reread.manifest.files.length, built.manifest.files.length, '读回文件数')
    for (const entry of built.manifest.files.slice(0, 30)) {
      const target = path.join(built.dir, ...entry.file.split('/'))
      assert(existsSync(target), `包内文件不存在：${entry.file}`)
      assertEqual(statSync(target).size, entry.size, `${entry.file} 大小`)
    }
    return `manifest ${(statSync(manifestPath).size / 1024).toFixed(1)}KB`
  })

  await check('buildEnginePackage：同盘优先硬链接（linked+copied=文件数），进度单调到 1', () => {
    assertEqual(built.linked + built.copied, built.manifest.files.length, 'linked+copied')
    assert(built.linked >= 1, `同盘构建应至少硬链接 1 个文件（实际 linked=${built.linked}）`)
    assert(progress.length >= 2, '进度回调太少')
    for (let index = 1; index < progress.length; index++) {
      assert(progress[index].value >= progress[index - 1].value, '进度必须单调不减')
    }
    assertEqual(progress.at(-1).value, 1, '最终进度 = 1')
    return `linked=${built.linked} copied=${built.copied}`
  })

  await check('buildEnginePackage：训练数据默认不打包（includeTraining=false）', async () => {
    const noTraining = await buildEnginePackage({
      dataDir: DATA_A,
      outDir: path.join(TMP, 'package-no-training'),
      profiles: ['essential'],
    })
    assert(noTraining.manifest.files.every((file) => !file.key.startsWith('training/')), '不应包含 training/*')
    const expectedNoTraining = expectedArtifacts(['essential'], false)
    // essential 的模型是 xl 的子集，运行时/适配器/CUDA 相同
    assertEqual(noTraining.manifest.files.length, expectedNoTraining.size, '文件数')
    return `${noTraining.manifest.files.length} 个文件（无训练数据）`
  })

  /* ---------------- 2. 文件缺失时跳过 + warnings ---------------- */
  await check('buildEnginePackage：文件缺失/大小不符时跳过并汇总 warnings', async () => {
    const missingRuntime = PLATFORM === 'win32-x64' ? MODERN_RUNTIME_FILES[0].name : null
    const missingModel = 'acestep-v15-turbo-Q8_0.gguf'
    createInstalledFixture(DATA_B, {
      omitRuntime: missingRuntime ? [missingRuntime] : [],
      omitModels: [missingModel],
      omitAdapters: true,
      training: false,
    })
    // 故意造一个大小不符的文件（截断 1 字节）
    const brokenModel = 'vae-BF16.gguf'
    const brokenPath = path.join(DATA_B, PROVISION_DIR_NAME, 'models', brokenModel)
    writeSparseFile(brokenPath, MODEL_FILES.find((file) => file.name === brokenModel).size - 1)
    const partial = await buildEnginePackage({ dataDir: DATA_B, outDir: path.join(TMP, 'package-b'), profiles: ['essential'] })
    assert(partial.warnings.length >= 2, `warnings=${partial.warnings.length}（应含缺运行时/模型/适配器）`)
    const keys = partial.manifest.files.map((file) => file.key)
    if (missingRuntime) assert(!keys.includes(`runtime/${missingRuntime}`), '缺失运行时不应进清单')
    assert(!keys.includes(`model/${missingModel}`), '缺失模型不应进清单')
    assert(!keys.includes(`model/${brokenModel}`), '大小不符模型不应进清单')
    assert(partial.manifest.files.length > 0, '其它文件仍应打包成功')
    for (const key of keys) assert(expectedArtifacts(['essential'], false).has(key), `清单里出现非计划文件：${key}`)
    return `${partial.manifest.files.length} 个文件，跳过 ${partial.warnings.length} 个`
  })

  /* ---------------- 2b. P11：tar.gz 写入 + 适配器回打归档 ---------------- */
  await check('createTarGz：ustar/gzip 往返（含 prefix 拆分）、确定性、非法路径拒绝', () => {
    const entries = new Map([
      ['jrpg_v1/adapter.json', Buffer.from('{"id":"jrpg_v1","rank":8}')],
      ['jrpg_v1/adapter_model.safetensors', Buffer.alloc(700, 0x5a)],
      ['empty.bin', Buffer.alloc(0)],
    ])
    // 超过 100 字节、但可拆成 prefix（≤155）+ name（≤100）的路径
    const longName = `${'a'.repeat(60)}/${'b'.repeat(60)}/c.bin`
    entries.set(longName, Buffer.from('prefix-split'))
    const first = createTarGz(entries, { mtime: 0 })
    const second = createTarGz(
      [...entries].map(([name, data]) => ({ name, data })),
      { mtime: 0 },
    )
    assert(first.equals(second), '同样输入 + 同样 mtime 应产出完全一致的字节（确定性）')
    const roundtrip = extractTarGz(first)
    assertEqual([...roundtrip.keys()].sort(), [...entries.keys()].sort(), '往返后条目名集合')
    for (const [name, data] of entries) assert(roundtrip.get(name).equals(data), `${name} 内容不一致`)
    for (const bad of ['../escape', '/abs/path', 'a/../../b', '']) {
      let thrown = null
      try {
        createTarGz(new Map([[bad, Buffer.from('x')]]))
      } catch (error) {
        thrown = error
      }
      assert(thrown, `非法条目名应抛错：${bad}`)
    }
    let longThrown = null
    try {
      createTarGz(new Map([[`single-${'x'.repeat(120)}`, Buffer.from('x')]]))
    } catch (error) {
      longThrown = error
    }
    assert(longThrown, '单段超过 100 字节且无法用 prefix 拆分时应抛错')
    return `${roundtrip.size} 个条目 / ${first.length}B`
  })

  await check('buildEnginePackage：适配器只剩已解压目录 → 回打 tar.gz，manifest 用实际 size/sha256，解压语义一致', async () => {
    // DATA_D：运行时/模型已装、适配器归档缺失（omitAdapters），只剩 data/adapters/<id>/
    createInstalledFixture(DATA_D, { omitAdapters: true })
    writeExtractedAdapters(DATA_D)
    const pkgDir = path.join(TMP, 'package-extracted-adapters')
    const result = await buildEnginePackage({ dataDir: DATA_D, outDir: pkgDir, profiles: ['essential'] })
    assertEqual(result.linked + result.copied, result.manifest.files.length, 'linked+copied 必须等于文件数')
    assert(
      !result.warnings.some((warning) => warning.includes('风格适配器')),
      `适配器不应被跳过：${result.warnings.join('；')}`,
    )
    assertEqual(result.manifest.files.length, expectedArtifacts(['essential'], false).size, '文件数')

    const installDir = path.join(TMP, 'extracted-adapters-install', 'adapters')
    let generatedBytes = 0
    for (const asset of ADAPTER_ASSETS) {
      const key = `adapter/${asset.file}`
      const entry = result.manifest.files.find((file) => file.key === key)
      assert(entry, `缺适配器 key：${key}`)
      assertEqual(entry.file, `adapters/${asset.file}`, `${asset.id} 包内路径`)
      const archivePath = path.join(pkgDir, ...entry.file.split('/'))
      assert(existsSync(archivePath), `${asset.id} 包内缺少回打的归档`)
      const archive = readFileSync(archivePath)
      generatedBytes += archive.length
      assertEqual(entry.size, archive.length, `${asset.id} manifest size 必须是生成文件实际值`)
      assertEqual(entry.sha256, sha256(archive), `${asset.id} manifest sha256 必须是生成文件实际值`)
      assert(
        entry.size !== asset.size || entry.sha256 !== asset.sha256,
        `${asset.id} 不应沿用清单钉死值（归档由本机已解压目录回打）`,
      )
      // 包内归档布局与官方一致：<id>/adapter.json + <id>/adapter_model.safetensors
      const entriesMap = extractTarGz(archive)
      assert(entriesMap.has(`${asset.id}/adapter.json`), `${asset.id} 归档缺 adapter.json`)
      assert(entriesMap.has(`${asset.id}/adapter_model.safetensors`), `${asset.id} 归档缺权重文件`)
      assertEqual(JSON.parse(entriesMap.get(`${asset.id}/adapter.json`).toString('utf8')).id, asset.id, `${asset.id} adapter.json id`)
      // 安装器语义：findLocalArtifact 命中离线包 → copyLocalArtifact 拷出 → 解压到 data/adapters
      const artifact = findLocalArtifact(DATA_D, key, pkgDir)
      assert(artifact && artifact.origin === 'package', `${asset.id} 应从离线包命中（origin=package）`)
      assertEqual(artifact.size, archive.length, `${asset.id} 离线包命中 size`)
      const copiedArchive = path.join(TMP, 'extracted-adapters-install', asset.file)
      assert(await copyLocalArtifact(artifact, copiedArchive), `${asset.id} 离线包归档应可拷出（sha256 校验通过）`)
      extractTarGzFileToDir(copiedArchive, installDir)
      assert(existsSync(path.join(installDir, asset.id, 'adapter.json')), `${asset.id} 解压后应有 data/adapters/<id>/adapter.json`)
      assert(
        existsSync(path.join(installDir, asset.id, 'adapter_model.safetensors')),
        `${asset.id} 解压后应有 data/adapters/<id>/adapter_model.safetensors`,
      )
    }

    // 归档缓存优先：DATA_E 同时有 .downloads 归档与已解压目录 → 不回打，manifest 仍用清单钉死值
    createInstalledFixture(DATA_E, {})
    writeExtractedAdapters(DATA_E)
    const priority = await buildEnginePackage({ dataDir: DATA_E, outDir: path.join(TMP, 'package-adapter-priority'), profiles: ['essential'] })
    for (const asset of ADAPTER_ASSETS) {
      const entry = priority.manifest.files.find((file) => file.key === `adapter/${asset.file}`)
      assert(entry, `${asset.id}（有归档缓存）缺 key`)
      assertEqual(entry.size, asset.size, `${asset.id} 有归档缓存时应沿用清单钉死 size`)
      assertEqual(entry.sha256, asset.sha256, `${asset.id} 有归档缓存时应沿用清单钉死 sha256`)
    }
    return `${ADAPTER_ASSETS.length} 个适配器回打归档 / ${generatedBytes}B`
  })

  /* ---------------- 3. findLocalArtifact ---------------- */
  await check('findLocalArtifact：离线包优先于已安装缓存；自定义包目录生效', () => {
    const key = 'model/acestep-v15-turbo-Q8_0.gguf'
    const fromPackage = findLocalArtifact(DATA_A, key)
    assert(fromPackage, '没找到 essential 模型')
    assertEqual(fromPackage.origin, 'package', '应优先命中离线包')
    assert(fromPackage.path.includes(`${path.sep}engine-package${path.sep}`), `path=${fromPackage.path}`)

    // DATA_C：只有离线包与 cache 同 key 冲突 → 仍应返回 package
    const small = createSmallPackage(DATA_C)
    writeSparseFile(
      path.join(DATA_C, PROVISION_DIR_NAME, 'models', small.modelName),
      MODEL_FILES.find((file) => file.name === small.modelName).size,
    )
    const smallHit = findLocalArtifact(DATA_C, `model/${small.modelName}`)
    assert(smallHit && smallHit.origin === 'package', `期望 package，实际 ${smallHit?.origin}`)
    // 指向不存在的包目录 → 回退 cache
    const cacheHit = findLocalArtifact(DATA_C, `model/${small.modelName}`, path.join(TMP, 'no-such-package'))
    assert(cacheHit && cacheHit.origin === 'cache', `期望 cache，实际 ${cacheHit?.origin}`)
    // 未知 key / 穿越 key
    for (const bad of ['model/not-a-model.gguf', '../settings.json', 'model/../../settings.json', 'runtime/../../x', 'training/checkpoint/../../../x']) {
      assertEqual(findLocalArtifact(DATA_A, bad), null, `非法 key ${bad}`)
    }
    return 'package > cache；自定义目录；非法 key 拒绝'
  })

  await check('findLocalArtifact：training key（code/python/dataset/checkpoint）package / cache 均可定位', () => {
    // DATA_A 有含训练数据的离线包 → 优先命中 package
    const fromPackage = findLocalArtifact(DATA_A, 'training/code')
    assert(fromPackage && fromPackage.origin === 'package', 'package 里的 training/code 未命中')
    // DATA_B 没有离线包，补一份训练下载缓存 → 命中 cache
    const root = path.join(DATA_B, 'training')
    writeSparseFile(path.join(root, '.downloads', TRAINING_CODE.file), TRAINING_CODE.size)
    writeSparseFile(path.join(root, '.downloads', PYTHON_ASSET.file), PYTHON_ASSET.size)
    writeSparseFile(path.join(root, '.downloads', TRAINING_DATASETS[0].file), TRAINING_DATASETS[0].size)
    const checkpoint = TRAINING_CHECKPOINTS.find((file) => file.dest === 'vae/diffusion_pytorch_model.safetensors')
    writeSparseFile(path.join(root, 'checkpoints', ...checkpoint.dest.split('/')), checkpoint.size)
    const code = findLocalArtifact(DATA_B, 'training/code')
    assert(code && code.origin === 'cache', 'training/code 未命中缓存')
    const python = findLocalArtifact(DATA_B, 'training/python')
    assert(python && python.origin === 'cache', 'training/python 未命中缓存')
    const dataset = findLocalArtifact(DATA_B, 'training/dataset/jrpg_v1')
    assert(dataset && dataset.origin === 'cache', 'training/dataset 未命中缓存')
    const checkpointHit = findLocalArtifact(DATA_B, 'training/checkpoint/vae/diffusion_pytorch_model.safetensors')
    assert(checkpointHit && checkpointHit.origin === 'cache', 'training/checkpoint 未命中缓存')
    return 'package + cache 全部可定位'
  })

  /* ---------------- 4. copyLocalArtifact ---------------- */
  await check('copyLocalArtifact：成功拷贝 + sha256 校验 + 哈希不符删除 dest', async () => {
    const payload = Buffer.from('aiab-p10b-copy-artifact-'.repeat(200))
    const sourcePath = path.join(TMP, 'copy-source.bin')
    writeFileSync(sourcePath, payload)
    const digest = sha256(payload)
    const dest = path.join(TMP, 'copy-dest', 'artifact.bin')
    const ok = await copyLocalArtifact({ path: sourcePath, size: payload.length, sha256: digest, origin: 'cache' }, dest)
    assert(ok === true, '合法文件应拷贝成功')
    assert(readFileSync(dest).equals(payload), '拷贝内容不一致')

    const badDest = path.join(TMP, 'copy-dest', 'bad.bin')
    const bad = await copyLocalArtifact(
      { path: sourcePath, size: payload.length, sha256: '0'.repeat(64), origin: 'cache' },
      badDest,
    )
    assert(bad === false, 'sha256 不符应返回 false')
    assert(!existsSync(badDest), 'sha256 不符必须删除 dest')

    const sizeBadDest = path.join(TMP, 'copy-dest', 'size-bad.bin')
    const sizeBad = await copyLocalArtifact({ path: sourcePath, size: payload.length + 1, sha256: digest, origin: 'cache' }, sizeBadDest)
    assert(sizeBad === false && !existsSync(sizeBadDest), 'size 不符应返回 false 且不留文件')
    return `sha256=${digest.slice(0, 8)}…`
  })

  await check('copyLocalArtifact：离线包文件正常时成功；包内文件损坏（哈希不符）返回 false', async () => {
    const small = createSmallPackage(DATA_C)
    const artifact = findLocalArtifact(DATA_C, `model/${small.modelName}`)
    assert(artifact && artifact.origin === 'package', 'offline package artifact')
    const dest = path.join(TMP, 'copy-package', 'tiny.gguf')
    const ok = await copyLocalArtifact(artifact, dest)
    assert(ok === true, '离线包合法文件应拷贝成功')
    assert(readFileSync(dest).equals(small.content), '离线包文件内容不一致')
    // 篡改包内文件（保持同 size，仅内容变化）后，哈希校验必须拒绝（防止被污染的离线包装进引擎目录）
    const tampered = path.join(DATA_C, 'engine-package', ...small.relative.split('/'))
    writeFileSync(tampered, Buffer.alloc(small.content.length, 0x7a))
    const badDest = path.join(TMP, 'copy-package', 'tampered.gguf')
    const bad = await copyLocalArtifact(findLocalArtifact(DATA_C, `model/${small.modelName}`), badDest)
    assert(bad === false && !existsSync(badDest), '被篡改的离线包文件必须被拒绝且删除 dest')
    return '合法通过 / 篡改拒绝'
  })

  await check('copyLocalArtifact：AbortSignal 取消时抛 AbortError', async () => {
    const sourcePath = path.join(TMP, 'copy-source.bin')
    const controller = new AbortController()
    controller.abort()
    let thrown = null
    try {
      await copyLocalArtifact({ path: sourcePath, size: statSync(sourcePath).size, origin: 'cache' }, path.join(TMP, 'copy-dest', 'aborted.bin'), {
        signal: controller.signal,
      })
    } catch (error) {
      thrown = error
    }
    assert(thrown && thrown.name === 'AbortError', `应抛 AbortError，实际 ${thrown?.name}`)
    return 'AbortError'
  })

  /* ---------------- 4b. CLI fetch 补写 runtime.json（纯函数） ---------------- */
  await check('CLI fetch helper：modern 运行时文件 → 写 runtime.json（服务端版本/平台，files 计数）', () => {
    const dest = path.join(TMP, 'cli-fetch-runtime')
    const runtime = { api: 'modern', version: RUNTIME_VERSION, platform: PLATFORM }
    const keys = ['runtime/ace-lm.exe', 'runtime/ace-server.exe', 'model/vae-BF16.gguf', 'model/xl.gguf']
    const written = writeFetchedRuntimeManifest(dest, { runtime, files: keys, source: 'http://nas:8787' })
    assert(written.written === true, `应写入 runtime.json：${JSON.stringify(written)}`)
    const record = JSON.parse(readFileSync(path.join(dest, 'runtime.json'), 'utf8'))
    assertEqual(record.api, 'modern', 'api')
    assertEqual(record.version, RUNTIME_VERSION, 'version 用服务端 runtime.json')
    assertEqual(record.platform, PLATFORM, 'platform 用服务端')
    assertEqual(record.files, 2, 'files 只统计 runtime/ 文件数')
    assertEqual(record.source, 'http://nas:8787', 'source')
    assert(!Number.isNaN(Date.parse(record.installedAt)), 'installedAt 必须 ISO')
    // 已有 runtime.json 不覆盖（避免把已装环境改坏）
    const again = writeFetchedRuntimeManifest(dest, { runtime: { api: 'modern', version: 'newer' }, files: ['runtime/ace-server.exe'] })
    assert(!again.written && again.reason === 'existing', `已有文件不应覆盖：${JSON.stringify(again)}`)
    assertEqual(JSON.parse(readFileSync(path.join(dest, 'runtime.json'), 'utf8')).version, RUNTIME_VERSION, '原文件保持不变')
    return `api=${record.api} version=${record.version} files=${record.files}`
  })

  await check('CLI fetch helper：无服务端 runtime 信息 → 回退默认值；legacy 归档不写', () => {
    const record = buildFetchedRuntimeRecord({ files: ['runtime/ace-server.exe'], source: 'http://nas:8787' })
    assert(record, 'modern runtime 文件应生成记录')
    assertEqual(record.version, 'fetched-from-server', 'version 默认值')
    assert(/^[a-z0-9]+-(x64|arm64)$/.test(record.platform), `platform 回退值：${record.platform}`)
    const legacyDest = path.join(TMP, 'cli-fetch-legacy')
    const legacy = writeFetchedRuntimeManifest(legacyDest, {
      runtime: { api: 'legacy' },
      files: ['runtime-archive/acestep-macos-arm64-metal.tar.gz', 'model/vae-BF16.gguf'],
      source: 'http://nas:8787',
    })
    assert(!legacy.written && legacy.reason === 'legacy-archive', `legacy 不应写：${JSON.stringify(legacy)}`)
    assert(!existsSync(path.join(legacyDest, 'runtime.json')), 'legacy 场景不应创建 runtime.json')
    return '默认值 + legacy 不写'
  })

  /* ---------------- 5. listMirrorFiles / resolveMirrorFile ---------------- */
  await check('listMirrorFiles：合并离线包与缓存、training=false 过滤训练数据', () => {
    const all = listMirrorFiles(DATA_A)
    assertEqual(all.length, expected.size, '文件数')
    assert(all.every((file) => file.origin === 'package'), '有离线包时应全部来自 package')
    assert(all.every((file) => file.size > 0), 'size 必须 > 0')
    const noTraining = listMirrorFiles(DATA_A, { training: false })
    assert(noTraining.every((file) => !file.key.startsWith('training/')), 'training=false 仍含训练数据')
    assertEqual(noTraining.length, expected.size - (1 + 1 + TRAINING_DATASETS.length + TRAINING_CHECKPOINTS.length), '训练文件数过滤')
    // 没有离线包的目录 → 从已安装缓存发现
    const cacheOnly = listMirrorFiles(DATA_B)
    assert(cacheOnly.length > 0 && cacheOnly.every((file) => file.origin === 'cache'), 'DATA_B 应全部来自 cache')
    assert(cacheOnly.some((file) => file.key.startsWith('model/')), '缓存清单应含模型')
    return `package=${all.length} / 无训练=${noTraining.length} / cache=${cacheOnly.length}`
  })

  await check('resolveMirrorFile：合法 key 命中；目录穿越/绝对路径/未知 key 全部拒绝', () => {
    const sampleKey = PLATFORM === 'win32-x64' ? `runtime/${MODERN_RUNTIME_FILES[0].name}` : `runtime-archive/${RUNTIME_ASSETS[PLATFORM].archive}`
    const resolved = resolveMirrorFile(DATA_A, sampleKey)
    assert(resolved && resolved.size > 0 && existsSync(resolved.path), `${sampleKey} 未解析`)
    const traversal = [
      '../settings.json',
      '../../data/settings.json',
      'model/../../settings.json',
      'runtime/../../../settings.json',
      'training/checkpoint/../../../settings.json',
      'C:/Windows/win.ini',
      'C:\\Windows\\win.ini',
      '/etc/passwd',
      'model/%2e%2e%2f%2e%2e%2fsettings.json',
      'model/..',
      '',
      'model/not-a-model.gguf',
      'runtime/..%2f..%2fsettings.json',
    ]
    for (const key of traversal) {
      assertEqual(resolveMirrorFile(DATA_A, key), null, `非法 key 不应解析：${key}`)
      assertEqual(parseEngineKey(key), null, `非法 key 不应通过 parseEngineKey：${key}`)
    }
    return `${path.basename(resolved.path)} · ${resolved.size}B`
  })

  /* ---------------- 6. HTTP 路由（Fastify inject） ---------------- */
  const TOKEN = 'verify-mirror-token'
  writeSettings(DATA_A, {
    sourceStrategy: 'auto',
    concurrency: 4,
    serverAssist: true,
    serverAssistToken: TOKEN,
    useLocalPackage: true,
    packageDir: '',
  })
  const app = await buildServer()
  const mirrorKey = PLATFORM === 'win32-x64' ? `runtime/${MODERN_RUNTIME_FILES[0].name}` : `runtime-archive/${RUNTIME_ASSETS[PLATFORM].archive}`
  const mirrorSize = expected.get(mirrorKey).size
  try {
    await check('GET /api/provision/status：download 字段（策略/镜像/并发/助攻/离线包统计）', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/provision/status' })
      assertEqual(response.statusCode, 200, 'HTTP')
      const body = response.json()
      const download = body.download
      assert(download, '缺少 download 字段')
      assertEqual(download.strategy, 'auto', 'strategy')
      assertEqual(download.hfMirror, 'https://hf-mirror.com', 'hfMirror 默认内置')
      assertEqual(download.githubMirror, 'https://ghfast.top/', 'githubMirror 默认内置')
      assertEqual(download.runtimeMirror, '', 'runtimeMirror')
      assertEqual(download.concurrency, 4, 'concurrency')
      assertEqual(download.serverAssist, true, 'serverAssist')
      assertEqual(download.useLocalPackage, true, 'useLocalPackage')
      assertEqual(download.packagePresent, true, 'packagePresent')
      assertEqual(download.packageFiles, expected.size, 'packageFiles')
      assertEqual(download.packageBytes, [...expected.values()].reduce((sum, meta) => sum + meta.size, 0), 'packageBytes')
      assertEqual(download.packagePath, path.join(DATA_A, 'engine-package'), 'packagePath')
      assert(typeof body.runtime === 'object' && Array.isArray(body.profiles), '原有字段保持')
      return `${download.packageFiles} 个离线包文件 / ${(download.packageBytes / GB).toFixed(2)}GB`
    })

    await check('GET /api/provision/mirror/manifest：令牌 401 → header/query 令牌 200', async () => {
      const denied = await app.inject({ method: 'GET', url: '/api/provision/mirror/manifest' })
      assertEqual(denied.statusCode, 401, '无令牌应 401')
      const viaHeader = await app.inject({ method: 'GET', url: '/api/provision/mirror/manifest', headers: authHeaders(TOKEN) })
      assertEqual(viaHeader.statusCode, 200, 'header 令牌')
      const body = viaHeader.json()
      assertEqual(body.enabled, true, 'enabled')
      assert(body.package && body.package.schema === 1, 'package manifest')
      assertEqual(body.files.length, expected.size, 'files 数')
      // runtime 摘要（供 CLI fetch 写 runtime.json）
      assertEqual(body.runtime?.api, serverRuntimeRecord.api, 'runtime.api')
      const expectedRuntimeVersion = /^\d+(\\.\\d+){1,3}$/.test(serverRuntimeRecord.version)
        ? serverRuntimeRecord.version
        : ENGINE_RUNTIME_VERSION
      assertEqual(body.runtime?.version, expectedRuntimeVersion, 'runtime.version（对外显示品牌版本）')
      assertEqual(body.runtime?.platform, serverRuntimeRecord.platform, 'runtime.platform')
      const sample = body.files.find((file) => file.key === mirrorKey)
      assert(sample && sample.size === mirrorSize && sample.sha256 === expected.get(mirrorKey).sha256, '文件元信息')
      const modelEntry = body.files.find((file) => file.key.startsWith('model/'))
      assert(Array.isArray(modelEntry?.profiles) && modelEntry.profiles.length > 0, '模型条目应附 profiles（CLI 过滤用）')
      const viaQuery = await app.inject({ method: 'GET', url: `/api/provision/mirror/manifest?token=${TOKEN}` })
      assertEqual(viaQuery.statusCode, 200, 'query 令牌')
      return `files=${body.files.length}`
    })

    await check('GET /api/provision/mirror/file：整文件 200 / HEAD / Range 206 / 416', async () => {
      const url = `/api/provision/mirror/file?key=${encodeURIComponent(mirrorKey)}`
      const full = await app.inject({ method: 'GET', url, headers: authHeaders(TOKEN) })
      assertEqual(full.statusCode, 200, '整文件 HTTP')
      assertEqual(full.headers['accept-ranges'], 'bytes', 'Accept-Ranges')
      assertEqual(Number(full.headers['content-length']), mirrorSize, 'Content-Length')
      assertEqual(full.rawPayload.length, mirrorSize, '整文件字节数')
      assert(/octet-stream/.test(String(full.headers['content-type'])), 'Content-Type')
      // Range 0-9
      const ranged = await app.inject({ method: 'GET', url, headers: { ...authHeaders(TOKEN), range: 'bytes=0-9' } })
      assertEqual(ranged.statusCode, 206, 'Range HTTP')
      assertEqual(ranged.headers['content-range'], `bytes 0-9/${mirrorSize}`, 'Content-Range')
      assertEqual(Number(ranged.headers['content-length']), 10, 'Range Content-Length')
      assertEqual(ranged.rawPayload.length, 10, 'Range 字节数')
      // 开放区间
      const open = await app.inject({ method: 'GET', url, headers: { ...authHeaders(TOKEN), range: 'bytes=10-' } })
      assertEqual(open.statusCode, 206, '开放 Range')
      assertEqual(open.headers['content-range'], `bytes 10-${mirrorSize - 1}/${mirrorSize}`, '开放 Range Content-Range')
      assertEqual(open.rawPayload.length, mirrorSize - 10, '开放 Range 字节数')
      // 后缀区间
      const suffix = await app.inject({ method: 'GET', url, headers: { ...authHeaders(TOKEN), range: 'bytes=-8' } })
      assertEqual(suffix.statusCode, 206, '后缀 Range')
      assertEqual(suffix.headers['content-range'], `bytes ${mirrorSize - 8}-${mirrorSize - 1}/${mirrorSize}`, '后缀 Range Content-Range')
      // HEAD
      const head = await app.inject({ method: 'HEAD', url, headers: authHeaders(TOKEN) })
      assertEqual(head.statusCode, 200, 'HEAD HTTP')
      assertEqual(Number(head.headers['content-length']), mirrorSize, 'HEAD Content-Length')
      assertEqual(head.rawPayload.length, 0, 'HEAD 不应有 body')
      // 非法 Range → 416
      const invalid = await app.inject({ method: 'GET', url, headers: { ...authHeaders(TOKEN), range: `bytes=${mirrorSize + 10}-` } })
      assertEqual(invalid.statusCode, 416, '非法 Range 应 416')
      assertEqual(invalid.headers['content-range'], `bytes */${mirrorSize}`, '416 Content-Range')
      // query 令牌也可用
      const viaQuery = await app.inject({ method: 'GET', url: `${url}&token=${TOKEN}` })
      assertEqual(viaQuery.statusCode, 200, 'query 令牌下载')
      return `size=${mirrorSize} · 206/HEAD/416`
    })

    await check('GET /api/provision/mirror/file：未知 key / 穿越 key / 无令牌 404·401', async () => {
      const denied = await app.inject({ method: 'GET', url: `/api/provision/mirror/file?key=${encodeURIComponent(mirrorKey)}` })
      assertEqual(denied.statusCode, 401, '无令牌应 401')
      const unknown = await app.inject({
        method: 'GET',
        url: `/api/provision/mirror/file?key=${encodeURIComponent('model/not-a-model.gguf')}`,
        headers: authHeaders(TOKEN),
      })
      assertEqual(unknown.statusCode, 404, '未知 key 应 404')
      const traversalKeys = ['../settings.json', 'model/../../settings.json', 'C:/Windows/win.ini', 'model/%2e%2e%2f%2e%2e%2fsettings.json', '']
      for (const key of traversalKeys) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/provision/mirror/file?key=${encodeURIComponent(key)}`,
          headers: authHeaders(TOKEN),
        })
        assert(response.statusCode === 404 || response.statusCode === 400, `穿越 key ${key} 应 404/400，实际 ${response.statusCode}`)
      }
      return '401 / 404 / 穿越拒绝'
    })

    await check('serverAssist 关闭：manifest enabled=false、file 404；清空令牌后局域网开放', async () => {
      writeSettings(DATA_A, { serverAssist: false })
      const disabledManifest = await app.inject({ method: 'GET', url: '/api/provision/mirror/manifest' })
      assertEqual(disabledManifest.statusCode, 200, '关闭时 manifest 仍 200')
      const disabledBody = disabledManifest.json()
      assertEqual(disabledBody.enabled, false, 'enabled=false')
      assertEqual(disabledBody.files, [], 'files 空')
      assertEqual(disabledBody.runtime?.api, serverRuntimeRecord.api, '关闭时也返回 runtime 摘要（便于排障）')
      const disabledFile = await app.inject({
        method: 'GET',
        url: `/api/provision/mirror/file?key=${encodeURIComponent(mirrorKey)}`,
        headers: authHeaders(TOKEN),
      })
      assertEqual(disabledFile.statusCode, 404, '关闭时 file 404')

      writeSettings(DATA_A, { serverAssist: true, serverAssistToken: '' })
      const open = await app.inject({ method: 'GET', url: `/api/provision/mirror/file?key=${encodeURIComponent(mirrorKey)}` })
      assertEqual(open.statusCode, 200, '未配置令牌时局域网开放')
      return '关闭 404 / 开放 200'
    })

    await check('GET /api/provision/sources：配置列表 + ?probe=1 探测结构（失败不 500）', async () => {
      const plain = await app.inject({ method: 'GET', url: '/api/provision/sources' })
      assertEqual(plain.statusCode, 200, 'HTTP')
      const plainBody = plain.json()
      assert(plainBody.config && plainBody.config.strategy === 'auto', 'config.strategy')
      assert(Array.isArray(plainBody.results) && plainBody.results.length === 0, '不带 probe 时 results 为空')
      // 探测：缩短超时，避免离线环境等待过久
      process.env.AIAB_SOURCE_PROBE_TIMEOUT_MS = '200'
      const started = Date.now()
      const probed = await app.inject({ method: 'GET', url: '/api/provision/sources?probe=1' })
      const elapsed = Date.now() - started
      delete process.env.AIAB_SOURCE_PROBE_TIMEOUT_MS
      assertEqual(probed.statusCode, 200, 'probe HTTP 不应 500')
      const probedBody = probed.json()
      assert(Array.isArray(probedBody.results) && probedBody.results.length >= 2, '探测结果太少')
      for (const item of probedBody.results) {
        assert(typeof item.label === 'string' && typeof item.url === 'string', '探测项字段')
        assert(typeof item.ok === 'boolean' && typeof item.latencyMs === 'number', 'ok/latencyMs 字段')
      }
      assert(elapsed < 8000, `探测耗时 ${elapsed}ms（应受超时保护）`)
      return `${probedBody.results.length} 个源 · ${elapsed}ms`
    })

    await check('POST /api/provision/package/build：异步任务 → jobs/:id 轮询 done + 结果', async () => {
      const outDir = path.join(TMP, 'route-package')
      const started = await app.inject({
        method: 'POST',
        url: '/api/provision/package/build',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ profiles: ['essential'], includeTraining: false, outDir }),
      })
      assertEqual(started.statusCode, 200, `启动构建 HTTP ${started.statusCode}`)
      const jobId = started.json().jobId
      assert(jobId, '缺少 jobId')
      let job = null
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const polled = await app.inject({ method: 'GET', url: `/api/provision/package/jobs/${jobId}` })
        assertEqual(polled.statusCode, 200, '查询任务 HTTP')
        job = polled.json().job
        assertEqual(job.id, jobId, 'job.id')
        if (job.status !== 'running') break
        await sleep(150)
      }
      assert(job && job.status === 'done', `构建未完成：${job?.status} ${job?.error ?? ''}`)
      assert(job.result && job.result.dir === outDir, 'result.dir')
      assertEqual(job.result.files, expectedArtifacts(['essential'], false).size, 'result.files')
      assert(job.result.bytes > 0, 'result.bytes')
      assert(Array.isArray(job.result.warnings), 'result.warnings')
      assert(existsSync(path.join(outDir, ENGINE_PACKAGE_MANIFEST)), '输出目录缺少清单')
      const missing = await app.inject({ method: 'GET', url: '/api/provision/package/jobs/pkg_missing' })
      assertEqual(missing.statusCode, 404, '未知构建任务应 404')
      return `${job.result.files} 个文件 / ${(job.result.bytes / GB).toFixed(2)}GB · ${job.result.linked} linked`
    })

    await check('安装路由校验 + 训练状态路由仍正常（接线不破坏 P8/P9/C）', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/provision/install',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ profiles: ['nope'] }),
      })
      assertEqual(bad.statusCode, 400, '未知 profile 应 400')
      const training = await app.inject({ method: 'GET', url: '/api/training/status' })
      assertEqual(training.statusCode, 200, 'training status HTTP')
      assert(typeof training.json().platform === 'string', 'training status 结构')
      return 'install 400 / training 200'
    })
  } finally {
    await app.close()
  }

  console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 存在失败'}  ${passed}/${passed + failed}\n`)
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* ignore */
  }
}
