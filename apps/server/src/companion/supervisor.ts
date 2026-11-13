/**
 * 本机生成节点（Companion）进程管理（P15）。
 *
 * 背景：Companion 是一个**独立进程**（`scripts/companion.mjs`），跑在 GPU 机器上，
 * 向服务端注册后才会有 worker 接单。以前产品里没有任何地方会启动它，所以用户
 * 「让 AI 生成音频」经常卡在「生成节点未连接」，等再久也不会变——因为那个进程
 * 从来就没被拉起来过，界面只给了「复制启动命令」。
 *
 * 单机形态（服务端与 GPU 同机）下，服务端自己就能拉起它：
 *
 *   - 提交生成任务 / 用户点「启动生成节点」→ `POST /api/companion/node/start`
 *   - 任务入队前如果没有任何在线 worker → 自动尝试拉起并等待注册（约 4s）
 *   - 服务端退出时回收子进程树（Windows 用 taskkill /T /F），避免残留 ace-server.exe
 *
 * 边界（不假装支持）：
 *   - 关闭自动启动：`AIAB_COMPANION_AUTOSTART=0`（只允许手动命令启动）
 *   - 镜像/打包部署里没有 `scripts/companion.mjs` → `available:false`，界面回退到
 *     「复制启动命令」，让用户到 GPU 机器上手动执行；
 *   - 跨机形态（NAS 控制面 + 另一台 GPU）同理：本机拉起的节点不在这台机器的 GPU 上。
 *
 * 与 Companion 的契约不变：本模块只负责**起进程**，注册/心跳/派单仍走
 * `/api/companion/*` 协议；「是否在线」永远以 worker 表为准，不看子进程是否活着。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { dataDir, host, port, repoRoot } from '../config.js'
import { forgetWorkersRegisteredSince, listWorkers } from './store.js'

/** 子进程状态（对外暴露给界面/接口） */
export type CompanionNodeState = 'stopped' | 'starting' | 'running' | 'failed'

export interface CompanionNodeStatus {
  /** 本机是否可以由服务端拉起节点（脚本存在且未被禁用） */
  available: boolean
  /** 是否为「允许自动启动」（AIAB_COMPANION_AUTOSTART） */
  autostart: boolean
  /** 是否允许「手动/一键启动」：available 且未被禁用 */
  controllable: boolean
  state: CompanionNodeState
  /** 子进程 pid（没有进程时为空） */
  pid?: number
  /** 子进程启动时刻（毫秒时间戳） */
  startedAt?: number
  /** 最近一次启动失败 / 退出的原因（中文） */
  reason?: string
  /** 最近一次退出码（有则给，便于排查） */
  exitCode?: number | null
  /** 日志文件绝对路径（界面不展示，排障用） */
  logPath?: string
  /** 日志尾部（最近约 1.5KB，界面折叠展示） */
  logTail?: string
  /** 节点启动命令（available:false 时给用户手动执行） */
  command: string
}

/** 启动等待：默认等 4s 注册（companion 冷启动到 register 约 0.3s，留足余量） */
const DEFAULT_START_WAIT_MS = 4000
/** 注册轮询间隔 */
const REGISTER_POLL_MS = 200
/** 日志尾部保留的字节数 */
const LOG_TAIL_BYTES = 1536
/** 停止时等待进程退出的时间 */
const STOP_GRACE_MS = 3000

const DEFAULT_COMPANION_SCRIPT = path.join(repoRoot, 'scripts', 'companion.mjs')
const LOG_DIR = path.join(dataDir, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'companion-node.log')

/**
 * 生成节点脚本路径：`AIAB_COMPANION_SCRIPT` 可覆盖（验收脚本 / 自定义部署布局用）。
 * 每次读取而不是模块级常量：测试可以在同一进程里改环境变量后立即生效。
 */
function companionScript(): string {
  const explicit = String(process.env.AIAB_COMPANION_SCRIPT ?? '').trim()
  return explicit ? path.resolve(explicit) : DEFAULT_COMPANION_SCRIPT
}

/** 当前被服务端拉起的子进程（只管理自己拉起的那一个，不碰用户手动启动的） */
let child: ChildProcess | null = null
let state: CompanionNodeState = 'stopped'
let reason: string | undefined
let startedAt: number | undefined
let lastExitCode: number | null | undefined
/** 进行中的启动（并发请求复用同一个 Promise，避免拉起多个节点） */
let starting: Promise<{ ok: boolean; online: boolean }> | null = null
/** 服务端正在退出：不再自动拉起 */
let shuttingDown = false

function envFlag(value: string | undefined): boolean {
  const text = String(value ?? '').trim().toLowerCase()
  return !(text === '0' || text === 'false' || text === 'off' || text === 'no')
}

/** 是否允许自动启动（默认开；AIAB_COMPANION_AUTOSTART=0 关闭） */
function autostartEnabled(): boolean {
  return envFlag(process.env.AIAB_COMPANION_AUTOSTART)
}

function scriptAvailable(): boolean {
  try {
    return existsSync(companionScript())
  } catch {
    return false
  }
}

/** 服务端地址：Companion 通过它注册；host 是 0.0.0.0 时用 127.0.0.1 */
function serverUrl(): string {
  const explicit = process.env.AIAB_COMPANION_SERVER
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, '')
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${target}:${port}`
}

function nodeCommandLine(): string {
  return `node scripts/companion.mjs --server ${serverUrl()} --engine --engine-idle 600`
}

function logTail(): string | undefined {
  try {
    const size = statSync(LOG_FILE).size
    if (!size) return undefined
    const raw = readFileSync(LOG_FILE)
    const slice = raw.subarray(Math.max(0, raw.length - LOG_TAIL_BYTES))
    const text = slice.toString('utf8')
    // 从第一处换行后开始，避免把被截断的半行日志当成完整行展示
    const firstBreak = text.indexOf('\n')
    return (firstBreak >= 0 ? text.slice(firstBreak + 1) : text).trim() || undefined
  } catch {
    return undefined
  }
}

function appendLog(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line, 'utf8')
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

/** 子进程是否还活着（exit/close 还没回调时 pid 仍有效） */
function childAlive(): boolean {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false
  try {
    process.kill(child.pid as number, 0)
    return true
  } catch {
    return false
  }
}

function refreshState(): void {
  if (childAlive()) {
    if (state !== 'starting') state = 'running'
    return
  }
  // 进程已经退出：清掉引用，状态回到 stopped / failed（reason 已由 exit 回调写好）
  child = null
  if (state !== 'failed') state = 'stopped'
}

/** 当前状态快照（/api/companion/node 与 /api/companion/status 用） */
export function companionNodeStatus(): CompanionNodeStatus {
  refreshState()
  return {
    available: scriptAvailable(),
    autostart: autostartEnabled(),
    controllable: scriptAvailable() && autostartEnabled(),
    state,
    pid: child?.pid,
    startedAt,
    reason,
    exitCode: lastExitCode ?? undefined,
    logPath: LOG_FILE,
    logTail: logTail(),
    command: nodeCommandLine(),
  }
}

/** 在线节点数 > 0 表示真的可以接单（与子进程存活无关：用户手动起的也算） */
export function companionOnline(): boolean {
  return listWorkers().length > 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等待 worker 注册（最多 waitMs；子进程提前退出/被禁用时立即失败） */
async function waitForRegistration(waitMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    if (companionOnline()) return true
    if (!waitMs || Date.now() >= deadline) return false
    // 启动失败（脚本缺失 / 子进程立即退出）时不要空等
    refreshState()
    if (state === 'failed') return false
    await sleep(REGISTER_POLL_MS)
  }
}

/** 结束子进程树：Windows 用 taskkill /T /F（ace-server.exe 是孙进程），其它平台 SIGTERM→SIGKILL */
function killTree(target: ChildProcess): void {
  const pid = target.pid
  if (pid == null) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      /* 退回 child.kill */
    }
  }
  try {
    target.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  const timer = setTimeout(() => {
    try {
      target.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, STOP_GRACE_MS)
  timer.unref?.()
}

/** 启动本机生成节点；已有存活子进程时直接返回（幂等） */
async function doStart(waitMs: number): Promise<{ ok: boolean; online: boolean }> {
  refreshState()
  if (companionOnline()) return { ok: true, online: true }
  if (!scriptAvailable()) {
    state = 'failed'
    reason = `找不到生成节点脚本（${companionScript()}）：当前部署形态（Docker / 仅打包 server）需要在跑 GPU 的机器上手动启动节点。`
    return { ok: false, online: false }
  }
  if (!autostartEnabled()) {
    state = 'stopped'
    reason = '自动启动已被禁用（AIAB_COMPANION_AUTOSTART=0）：请在 GPU 机器上手动执行生成节点启动命令。'
    return { ok: false, online: false }
  }
  if (shuttingDown) return { ok: false, online: false }

  // 子进程还在但还没注册（例如刚启动）：等它注册，不要重复 spawn
  if (childAlive()) {
    state = 'starting'
    return { ok: true, online: await waitForRegistration(waitMs) }
  }

  state = 'starting'
  reason = undefined
  lastExitCode = undefined
  startedAt = Date.now()
  appendLog(
    `\n===== ${new Date().toISOString()} 服务端拉起生成节点（${serverUrl()}）=====\n`,
  )

  let spawned: ChildProcess
  try {
    // 日志直接由子进程写文件描述符（stdio 指向打开的 fd），不是父进程接管道：
    //  1. 少一次数据搬运，服务端忙（生成/导出）时不会因管道背压拖慢节点；
    //  2. 某些受限环境不允许对子进程做管道采集（spawn 会 EPERM），沿用 fd 更稳。
    mkdirSync(LOG_DIR, { recursive: true })
    const logFd = openSync(LOG_FILE, 'a')
    try {
      spawned = spawn(
        process.execPath,
        [companionScript(), '--server', serverUrl(), '--engine', '--engine-idle', '600'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            // 让子进程和当前服务端用同一份数据目录（引擎目录 / 适配器 / 任务落盘）
            AIAB_DATA_DIR: process.env.AIAB_DATA_DIR || process.env.DATA_DIR || dataDir,
          },
          stdio: ['ignore', logFd, logFd],
          windowsHide: true,
        },
      )
    } finally {
      // 子进程已继承该 fd，父进程这份可以立刻关掉（Windows 上必须关，否则文件被占住）
      closeSync(logFd)
    }
  } catch (error) {
    state = 'failed'
    reason = `启动生成节点失败：${error instanceof Error ? error.message : String(error)}`
    appendLog(`${reason}\n`)
    return { ok: false, online: false }
  }

  child = spawned

  spawned.on('error', (error) => {
    state = 'failed'
    reason = `生成节点进程错误：${error.message}`
    appendLog(`${reason}\n`)
  })
  spawned.on('exit', (code, signal) => {
    lastExitCode = code
    if (child === spawned) child = null
    // 服务端退出时被我们主动杀掉：不要报成故障
    if (shuttingDown) {
      state = 'stopped'
      return
    }
    if (state === 'starting' || state === 'running') {
      state = 'failed'
      const tail = logTail()
      reason = `生成节点进程已退出（code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}）。${
        tail ? `日志尾部：${tail.split('\n').slice(-2).join(' / ')}` : '详情见 data/logs/companion-node.log'
      }`
    }
  })

  const online = await waitForRegistration(waitMs)
  if (online) {
    state = 'running'
    return { ok: true, online: true }
  }
  // 没在等待窗口内注册：进程可能还在冷启动（继续等它自己注册），也可能已经失败退出。
  // refreshState 只负责把「已退出」的情况收敛成 stopped / failed，不做别的判断。
  refreshState()
  return { ok: true, online: false }
}

/**
 * 确保有在线节点（提交任务前调用）。
 *
 * - 已有在线 worker → 立即返回 true（不管是谁启动的）
 * - 否则尝试拉起本机节点并等待注册
 * - 并发调用复用同一个启动 Promise，避免拉起多个 companion 抢任务
 */
export async function ensureCompanionOnline(waitMs = DEFAULT_START_WAIT_MS): Promise<boolean> {
  if (companionOnline()) return true
  if (!scriptAvailable() || !autostartEnabled() || shuttingDown) {
    refreshState()
    if (!reason) {
      reason = !scriptAvailable()
        ? `找不到生成节点脚本（${companionScript()}）：请在跑 GPU 的机器上手动启动节点。`
        : '自动启动已被禁用（AIAB_COMPANION_AUTOSTART=0）：请在 GPU 机器上手动执行启动命令。'
    }
    return false
  }
  if (!starting) {
    starting = doStart(waitMs).finally(() => {
      starting = null
    })
  }
  const result = await starting
  return result.online || companionOnline()
}

/** 显式「启动生成节点」（界面按钮）：force 时忽略 autostart 开关 */
export async function startCompanionNode(options: { waitMs?: number; force?: boolean } = {}): Promise<{
  ok: boolean
  online: boolean
  node: CompanionNodeStatus
}> {
  const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, Number(options.waitMs)) : DEFAULT_START_WAIT_MS
  if (companionOnline()) {
    refreshState()
    if (state !== 'running' && state !== 'starting') state = companionOnline() ? 'running' : state
    return { ok: true, online: true, node: companionNodeStatus() }
  }
  if (options.force && !autostartEnabled()) {
    // force 只是覆盖「自动启动被禁用」，用户显式点了按钮表示他现在就想启动
    state = state === 'failed' ? 'stopped' : state
  }
  if (!starting) {
    starting = doStart(waitMs).finally(() => {
      starting = null
    })
  }
  const result = await starting
  return { ok: result.online, online: result.online || companionOnline(), node: companionNodeStatus() }
}

/** 停止由服务端拉起的节点（用户手动启动的节点不受影响） */
export async function stopCompanionNode(): Promise<{ ok: boolean; node: CompanionNodeStatus }> {
  refreshState()
  if (!child) {
    state = state === 'failed' ? 'failed' : 'stopped'
    return { ok: false, node: companionNodeStatus() }
  }
  const target = child
  const spawnedAt = startedAt ?? Date.now()
  appendLog(`${new Date().toISOString()} 服务端停止生成节点（pid=${target.pid}）\n`)
  killTree(target)
  const deadline = Date.now() + STOP_GRACE_MS
  while (Date.now() < deadline) {
    if (!childAlive()) break
    await sleep(100)
  }
  child = null
  state = 'stopped'
  /**
   * 进程被杀后，worker 记录还会靠心跳 TTL 存活 60s。这段时间里提交任务会以为
   * 「有节点可派」而不再自动拉起，任务就干等——所以这里直接忘掉本次拉起期间注册的
   * worker。用户手动启动 / 其它机器的节点即使被误清，也会在下一次心跳收到 401 时
   * 自动重新注册（docs/COMPANION.md §1「会话失效自动重注册」）。
   */
  try {
    forgetWorkersRegisteredSince(spawnedAt)
  } catch {
    /* 清理失败不影响停止结论 */
  }
  return { ok: true, node: companionNodeStatus() }
}

/** 服务端退出时调用：回收子进程树，避免残留 companion / ace-server.exe */
export function shutdownCompanionNode(): void {
  shuttingDown = true
  if (child) killTree(child)
  child = null
}

/** 仅供测试：重置模块内状态（不杀进程） */
export function _resetCompanionNodeForTests(): void {
  child = null
  state = 'stopped'
  reason = undefined
  startedAt = undefined
  lastExitCode = undefined
  starting = null
  shuttingDown = false
}
