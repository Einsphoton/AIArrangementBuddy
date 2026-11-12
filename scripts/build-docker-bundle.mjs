#!/usr/bin/env node
/**
 * 构建「Docker 内置 AI 引擎包」：把已安装的运行时 + 模型 + LoRA 适配器（可选训练数据）
 * 打包到 docker/engine-package/，再（默认）执行 docker build，让镜像自带引擎、部署后零下载。
 *
 *   node scripts/build-docker-bundle.mjs [选项]
 *
 * 选项：
 *   --profiles essential[,quality,stems,xl]  档位（默认 essential；可叠加，XL 约 23.8GB）
 *   --training                               把训练代码 / Python / 数据集 / 检查点一起打包（体量大）
 *   --out <dir>                              离线包输出目录（默认 docker/engine-package）
 *   --tag <tag>                              镜像 tag（默认 ai-arrangement-buddy:bundled）
 *   --server <url>                           运行中的应用地址（默认 $AIAB_SERVER 或 http://127.0.0.1:8787）
 *   --no-build                               只生成离线包，不执行 docker build
 *   --clean                                  构建前清掉输出目录里的旧离线包内容（保留 README.md）
 *   --help / -h                              显示帮助
 *
 * 流程：
 * 1) 调运行中的服务端 `POST /api/provision/package/build`（outDir 传绝对路径），轮询
 *    `/api/provision/package/jobs/:id` 直到完成 —— 打包逻辑与设置页/`provision.mjs package` 完全一致；
 * 2) 校验输出目录里的 `engine-package.json`，打印文件数 / 体积 / 包含的能力；
 * 3) 默认接着 `docker build -t <tag> .`，透传退出码；`--no-build` 时只生成包。
 *
 * 服务端没启动时会给出中文提示：先 `node scripts/start.mjs`，或用
 * `node scripts/provision.mjs package --out docker/engine-package` 生成后再跑本脚本。
 *
 * 纯 Node（无新依赖；需要 Node 18+ 的内置 fetch）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_NAME = 'engine-package.json'
const VALID_PROFILES = ['essential', 'quality', 'stems', 'xl']
const PROFILE_LABELS = {
  essential: '基础能力（快速生成）',
  quality: '质量增强（精修 + 提示词增强）',
  stems: '分轨能力',
  xl: '增强版最佳质量（需 ≥12GB 显存）',
}
const PACKAGE_ENTRIES = ['runtime', 'runtime-archive', 'cuda', 'models', 'adapters', 'training', MANIFEST_NAME]

const args = process.argv.slice(2)

function hasFlag(name) {
  return args.includes(`--${name}`)
}

function getArg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`
}

function printHelp() {
  console.log(`AI 编曲伴侣 · Docker 内置引擎包构建

用法：
  node scripts/build-docker-bundle.mjs [选项]

选项：
  --profiles essential[,quality,stems,xl]  档位（默认 essential；xl 会自动包含 essential 的模型）
  --training                               把训练代码 / Python / 数据集 / 检查点一起打包（体量大，默认不含）
  --out <dir>                              离线包输出目录（默认 docker/engine-package）
  --tag <tag>                              镜像 tag（默认 ai-arrangement-buddy:bundled）
  --server <url>                           运行中的应用地址（默认 $AIAB_SERVER 或 http://127.0.0.1:8787）
  --no-build                               只生成离线包，不执行 docker build
  --clean                                  构建前清掉输出目录里的旧离线包内容（保留 README.md）
  --help, -h                               显示本帮助

示例：
  # 基础档（约 3.4GB）：生成离线包 + docker build
  node scripts/build-docker-bundle.mjs

  # XL 档 + 训练数据（约 30GB+）：只生成包，稍后手动 docker build
  node scripts/build-docker-bundle.mjs --profiles essential,xl --training --no-build

  # 生成到别的目录
  node scripts/build-docker-bundle.mjs --out docker/engine-package-xl --tag ai-arrangement-buddy:xl

说明：打包需要本机已装好引擎（设置 → 引擎下载 / provision.mjs install），并先启动应用（node scripts/start.mjs）。
完整文档：docs/DOCKER_ENGINE_BUNDLE.md`);
}

function parseProfiles(raw) {
  const list = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (list.length === 0) return ['essential']
  for (const item of list) {
    if (!VALID_PROFILES.includes(item)) {
      throw new Error(`未知档位：${item}（可用：${VALID_PROFILES.join(' / ')}）`)
    }
  }
  return [...new Set(list)]
}

async function requestJson(url, init, timeoutMs = 8000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

function serverUnavailableHint(server, profiles, outDir) {
  const list = profiles.join(',')
  console.error(`\n✗ 连不上运行中的应用（${server}），无法生成离线包。`)
  console.error('  请先启动应用，或改用命令行生成后再运行本脚本：\n')
  console.error('    # 方式一：启动应用（会打开 http://127.0.0.1:8787）后重试')
  console.error('    node scripts/start.mjs\n')
  console.error('    # 方式二：直接生成离线包，再手动 docker build')
  console.error(`    node scripts/provision.mjs package --profiles ${list}${outDir ? ` --out ${outDir}` : ''}`)
  console.error('')
  console.error('  生成完成后把离线包放到 docker/engine-package/，再执行：')
  console.error('    docker build -t ai-arrangement-buddy:bundled .')
}

/** --clean：只清理离线包产物，保留占位 README（避免把目录从 git 里删掉） */
function cleanPackageDir(outDir) {
  let removed = 0
  for (const entry of PACKAGE_ENTRIES) {
    const target = path.join(outDir, entry)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

function readManifestSummary(outDir) {
  const manifestPath = path.join(outDir, MANIFEST_NAME)
  if (!existsSync(manifestPath)) return null
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { error: `engine-package.json 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.files)) {
    return { error: 'engine-package.json 格式不认识（schema 不是 1 或缺少 files）' }
  }
  const kinds = new Map()
  let bytes = 0
  let present = 0
  for (const file of manifest.files) {
    const kind = String(file.kind ?? 'file')
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    const target = path.join(outDir, ...String(file.file).split('/'))
    if (existsSync(target)) {
      present += 1
      try {
        bytes += statSync(target).size
      } catch {
        /* 大小读不到就跳过（不影响展示） */
      }
    }
  }
  return { manifest, kinds, bytes, present }
}

function countByKind(kinds, prefix) {
  let total = 0
  for (const [kind, count] of kinds) {
    if (kind === prefix || kind.startsWith(prefix)) total += count
  }
  return total
}

function printSummary(outDir, summary, profiles, job) {
  const relative = path.relative(ROOT, outDir) || outDir
  console.log(`\n✓ 离线包已生成：${outDir}`)
  if (path.isAbsolute(relative)) {
    /* 输出目录在仓库外时直接显示绝对路径 */
  } else if (relative !== outDir) {
    console.log(`  （仓库内相对路径：${relative.split(path.sep).join('/')}）`)
  }
  console.log(`  文件：${summary.manifest.files.length} 个（实际落盘 ${summary.present} 个）/ ${humanBytes(summary.bytes)}`)
  const hardlink = Number(job?.result?.linked ?? 0)
  const copied = Number(job?.result?.copied ?? 0)
  if (hardlink + copied > 0) console.log(`  落盘方式：硬链接 ${hardlink} / 复制 ${copied}`)
  const capabilities = [
    ...profiles.map((profile) => `${profile}（${PROFILE_LABELS[profile] ?? profile}）`),
  ]
  const adapters = countByKind(summary.kinds, 'adapter')
  const models = countByKind(summary.kinds, 'model')
  const runtimes = countByKind(summary.kinds, 'runtime') + countByKind(summary.kinds, 'cuda')
  const trainingFiles = countByKind(summary.kinds, 'training')
  console.log(`  能力：${capabilities.join(' + ')}`)
  console.log(
    `  内容：运行时/CUDA ${runtimes} 个文件 · 模型 ${models} 个 · LoRA 适配器 ${adapters} 个` +
      (trainingFiles > 0 ? ` · 训练数据 ${trainingFiles} 个文件` : ' · 不含训练数据'),
  )
  if (summary.manifest.label) console.log(`  清单标识：${summary.manifest.label}`)
  const warnings = Array.isArray(job?.result?.warnings) ? job.result.warnings : []
  if (warnings.length > 0) {
    console.log(`  ⚠ ${warnings.length} 个文件被跳过（缺失/大小不符），镜像里将不含这些文件：`)
    for (const warning of warnings.slice(0, 10)) console.log(`    - ${warning}`)
    if (warnings.length > 10) console.log(`    …… 另有 ${warnings.length - 10} 条`)
  }
  if (adapters === 0) {
    console.log('  ⚠ 离线包里没有 LoRA 适配器：本机可能既没有 .downloads 归档，也没有 data/adapters/<id>/ 已解压目录')
  }
}

function printNextSteps(tag) {
  console.log('\n下一步：')
  console.log(`  docker build -t ${tag} .`)
  console.log('  # 或')
  console.log('  docker compose up -d --build')
  console.log('\n部署后：')
  console.log('  docker run -d --name aiab -p 8787:8787 -v aiab-data:/data ' + tag)
  console.log('  容器内安装引擎会优先用镜像里的 /app/engine-package（环境变量 AIAB_ENGINE_PACKAGE_DIR），不再下载。')
  console.log(`  局域网其它机器可从服务器镜像拉取：node scripts/provision.mjs fetch --from http://<nas>:8787 --dest <数据目录>`)
  console.log('  文档：docs/DOCKER_ENGINE_BUNDLE.md')
}

function dockerAvailable() {
  const probe = spawnSync('docker', ['--version'], { stdio: 'ignore', windowsHide: true })
  return !probe.error && probe.status === 0
}

/** 构建离线包（调服务端异步任务并轮询）；返回 job 或 null（已处理错误） */
async function runPackageBuild({ server, outDir, profiles, includeTraining }) {
  let start
  try {
    start = await requestJson(`${server}/api/provision/package/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles, includeTraining, outDir }),
    })
  } catch (error) {
    serverUnavailableHint(server, profiles, outDir)
    if (process.env.AIAB_DEBUG) console.error(error)
    return null
  }
  if (start.status === 409) {
    const jobId = start.body?.jobId ?? ''
    console.error(`\n✗ 已有离线包构建任务在进行中${jobId ? `（jobId=${jobId}）` : ''}，请等它完成或稍后重试。`)
    return null
  }
  if (start.status !== 200) {
    console.error(`\n✗ 启动离线包构建失败（HTTP ${start.status}）：${start.body?.error ?? JSON.stringify(start.body)}`)
    return null
  }
  const jobId = start.body?.jobId
  if (!jobId) {
    console.error('\n✗ 服务端没有返回 jobId，无法跟踪构建进度（请升级到 P10+ 版本）。')
    return null
  }
  console.log(`离线包构建任务已启动：${jobId}（profiles=${profiles.join(',')}${includeTraining ? '，含训练数据' : '，不含训练数据'}）`)

  let lastLine = ''
  let consecutiveErrors = 0
  for (;;) {
    let polled
    try {
      polled = await requestJson(`${server}/api/provision/package/jobs/${encodeURIComponent(jobId)}`, undefined, 20000)
    } catch (error) {
      consecutiveErrors += 1
      if (consecutiveErrors >= 5) {
        console.error(`\n✗ 轮询构建进度失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
      continue
    }
    consecutiveErrors = 0
    const job = polled.body?.job
    if (polled.status === 404 || !job) {
      console.error(`\n✗ 构建任务 ${jobId} 不存在（服务端可能重启过），请重试。`)
      return null
    }
    const percent = Math.round((job.progress ?? 0) * 100)
    const line = `${percent}% · ${job.message ?? ''}`
    if (line !== lastLine) {
      console.log(`进度 ${line}`)
      lastLine = line
    }
    if (job.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 800))
      continue
    }
    if (job.status === 'done') return job
    console.error(`\n✗ 离线包构建${job.status === 'canceled' ? '已取消' : '失败'}：${job.error ?? job.message ?? ''}`)
    return null
  }
}

async function main() {
  if (hasFlag('help') || args.includes('-h')) {
    printHelp()
    return 0
  }

  let profiles
  try {
    profiles = parseProfiles(getArg('profiles', getArg('profile', 'essential')))
  } catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const includeTraining = hasFlag('training')
  const tag = getArg('tag', 'ai-arrangement-buddy:bundled')
  const outArg = getArg('out', 'docker/engine-package')
  const outDir = path.resolve(ROOT, outArg)
  const server = (getArg('server', process.env.AIAB_SERVER || 'http://127.0.0.1:8787')).replace(/\/+$/, '')
  const skipBuild = hasFlag('no-build')
  const clean = hasFlag('clean')

  const serverHost = (() => {
    try {
      return new URL(server).hostname
    } catch {
      return server
    }
  })()
  const localServer = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(serverHost)

  console.log('AI 编曲伴侣 · Docker 内置引擎包构建')
  console.log(`  档位：${profiles.join(' + ')}${includeTraining ? ' + 训练数据' : ''}`)
  console.log(`  输出：${outDir}`)
  console.log(`  服务端：${server}`)
  if (!localServer) {
    console.log(`  ⚠ --server 不是本机：outDir 必须是「服务端所在机器」上的绝对路径，生成后请同步到本机仓库再 docker build`)
  }

  // 目录里的旧离线包：同名文件会被覆盖，但换档位后的残留文件不会自动清掉（可用 --clean）
  if (clean) {
    const removed = cleanPackageDir(outDir)
    console.log(`  --clean：已清理旧离线包内容（${removed} 项，保留 README.md）`)
  } else if (existsSync(path.join(outDir, MANIFEST_NAME))) {
    console.log('  提示：输出目录已有离线包，将覆盖同名文件；换档位后建议加 --clean 清掉旧档位残留')
  }
  mkdirSync(outDir, { recursive: true })

  const job = await runPackageBuild({ server, outDir, profiles, includeTraining })
  if (!job) return 1

  const summary = readManifestSummary(outDir)
  if (!summary || summary.error) {
    console.error(`\n✗ 构建任务结束但输出目录里没有可用的离线包：${summary?.error ?? '缺少 engine-package.json'}`)
    if (!localServer) {
      console.error('  因为 --server 指向其它机器，离线包在「服务端机器」上；请把该目录同步到本机仓库后再 docker build。')
    }
    return 1
  }
  printSummary(outDir, summary, profiles, job)

  if (skipBuild) {
    console.log('\n已跳过 docker build（--no-build）')
    printNextSteps(tag)
    return 0
  }

  if (!dockerAvailable()) {
    console.error('\n✗ 未检测到可用的 docker 命令，已跳过 docker build。')
    console.error('  请安装 Docker Desktop / Docker Engine 后重试，或在装好 Docker 的机器上执行：')
    console.error(`    docker build -t ${tag} .`)
    console.error('  （离线包已经生成，无需重新打包）')
    return 1
  }

  console.log(`\n开始 docker build：docker build -t ${tag} .（构建上下文 ${ROOT}）`)
  const started = Date.now()
  const result = spawnSync('docker', ['build', '-t', tag, ROOT], { stdio: 'inherit', windowsHide: false })
  const elapsed = Math.round((Date.now() - started) / 1000)
  if (result.error) {
    console.error(`\n✗ docker build 启动失败：${result.error.message}`)
    return 1
  }
  if (result.status !== 0) {
    console.error(`\n✗ docker build 失败（退出码 ${result.status}，耗时 ${elapsed}s）`)
    return result.status ?? 1
  }
  console.log(`\n✓ 镜像已构建：${tag}（耗时 ${elapsed}s）`)
  printNextSteps(tag)
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error('\n✗ 构建 Docker 引擎包失败：', error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
