#!/usr/bin/env node
/**
 * P15 契约验收：生成节点（Companion）自动启动 —— 静态断言。
 *
 *   node scripts/verify-companion-node-contract.mjs
 *
 * 这是一个**不需要浏览器 / 不需要 GPU** 的回归护栏，锁住这次修复的关键契约：
 *  1. 服务端：三个接口都注册了；入队前会 ensureCompanionOnline；503 带 node 原因
 *  2. 服务端：manage 进程的模块导出齐全（start/stop/ensure/status/shutdown）
 *  3. 服务端：服务端退出时回收子进程树
 *  4. store：worker 被移除时在途任务退回队列（否则界面会「卡运行中」）
 *  5. 前端：api 层有 getCompanionNode / startCompanionNode / stopCompanionNode，
 *     且 POST stop 带 body（Fastify 对「声明 JSON 却无 body」返回 400）
 *  6. 前端：阻塞态保留既有自动化钩子（data-audio-job-command / 「复制启动命令」/ .gen-btn）
 *  7. 前端：一键启动按钮只在可控时出现（旧服务端降级路径）
 *  8. 文档：COMPANION.md 有 §4.7；README 提到 AIAB_COMPANION_AUTOSTART
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gold: '\x1b[33m',
  bold: '\x1b[1m',
}

let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed++
  console.log(`  ${c.green}✓${c.reset} ${name}${detail ? c.dim + '  ' + detail + c.reset : ''}`)
}

function bad(name, error) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  failures.push({ name, message })
  console.log(`  ${c.red}✗${c.reset} ${name}${c.dim}  ${message}${c.reset}`)
}

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8')
}

/** 断言：源码里必须按顺序/独立出现这些片段 */
function mustInclude(label, source, fragments, fileLabel) {
  for (const fragment of fragments) {
    if (!source.includes(fragment)) {
      const where = source.split('\n').findIndex((line) => line.includes(fragment))
      throw new Error(`${fileLabel} 缺少：${fragment}${where >= 0 ? '' : ''}`)
    }
  }
}

function check(name, fn) {
  try {
    const detail = fn()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    bad(name, error)
  }
}

async function main() {
  console.log(`\n${c.gold}${c.bold}生成节点自动启动 · 契约验收${c.reset}`)
  console.log(`${c.dim}静态断言（不需要浏览器 / GPU）${c.reset}\n`)

  /* ---------------- 服务端：路由 ---------------- */
  check('服务端注册了 node / node/start / node/stop 三个接口', () => {
    const source = read('apps/server/src/routes/companion.ts')
    mustInclude('routes', source, [
      "'/api/companion/node'",
      "'/api/companion/node/start'",
      "'/api/companion/node/stop'",
    ], 'routes/companion.ts')
    return '3 个路由就位'
  })

  check('入队前会先尝试拉起本机节点（不再直接 503 干等）', () => {
    const source = read('apps/server/src/routes/companion.ts')
    const enqueueAt = source.indexOf("app.post<{ Body: Json }>('/api/companion/tasks'")
    if (enqueueAt < 0) throw new Error('找不到 /api/companion/tasks 路由')
    const ensureAt = source.indexOf('await ensureCompanionOnline()', enqueueAt)
    const workersAt = source.indexOf('if (listWorkers().length === 0)', enqueueAt)
    if (ensureAt < 0) throw new Error('入队流程没有调用 ensureCompanionOnline()')
    if (workersAt < 0) throw new Error('找不到「没有在线节点」判断')
    if (ensureAt < workersAt) throw new Error('ensureCompanionOnline 应在「无 worker」判断之后调用')
    return 'ensureCompanionOnline 在入队前'
  })

  check('503 响应带 node 状态（界面据此展示原因）', () => {
    const source = read('apps/server/src/routes/companion.ts')
    const at = source.indexOf('return reply.code(503).send({')
    if (at < 0) throw new Error('找不到 503')
    const block = source.slice(at, at + 700)
    if (!block.includes('node')) throw new Error('503 响应体没有 node 字段')
    if (!block.includes('启动生成节点')) throw new Error('错误信息没有引导「启动生成节点」')
    return '503 带 node + 引导文案'
  })

  check('/api/companion/status 返回 node 字段与离线 hint', () => {
    const source = read('apps/server/src/routes/companion.ts')
    const at = source.indexOf("app.get('/api/companion/status'")
    if (at < 0) throw new Error('找不到 status 路由')
    const block = source.slice(at, at + 1400)
    if (!block.includes('node,')) throw new Error('status 响应没有 node 字段')
    if (!block.includes('启动生成节点')) throw new Error('离线 hint 没提到「启动生成节点」')
    return 'status 带 node + 新 hint'
  })

  /* ---------------- 服务端：管理器 ---------------- */
  check('supervisor 导出 start/stop/ensure/status/shutdown', () => {
    const source = read('apps/server/src/companion/supervisor.ts')
    mustInclude('supervisor', source, [
      'export function companionNodeStatus',
      'export async function ensureCompanionOnline',
      'export async function startCompanionNode',
      'export async function stopCompanionNode',
      'export function shutdownCompanionNode',
    ], 'companion/supervisor.ts')
    return '5 个导出'
  })

  check('supervisor：支持 AIAB_COMPANION_AUTOSTART 开关与脚本覆盖', () => {
    const source = read('apps/server/src/companion/supervisor.ts')
    mustInclude('supervisor', source, ['AIAB_COMPANION_AUTOSTART', 'AIAB_COMPANION_SCRIPT', 'AIAB_COMPANION_SERVER'], 'companion/supervisor.ts')
    return '3 个环境变量'
  })

  check('supervisor：Windows 用 taskkill /T 结束子进程树（不残留 ace-server）', () => {
    const source = read('apps/server/src/companion/supervisor.ts')
    if (!source.includes("spawnSync('taskkill'")) throw new Error('没有 taskkill')
    if (!source.includes("'/T'")) throw new Error('taskkill 缺少 /T（只杀父进程会残留 ace-server.exe）')
    if (!source.includes("'/F'")) throw new Error('taskkill 缺少 /F')
    return 'taskkill /T /F'
  })

  check('supervisor：并发 start 复用同一个启动 Promise（不拉起多个节点）', () => {
    const source = read('apps/server/src/companion/supervisor.ts')
    if (!source.includes('let starting: Promise')) throw new Error('没有共享的 starting Promise')
    if (!source.includes('if (!starting)')) throw new Error('没有复用逻辑')
    return '共享 starting Promise'
  })

  check('服务端退出时回收生成节点进程', () => {
    const source = read('apps/server/src/index.ts')
    if (!source.includes('shutdownCompanionNode')) throw new Error('index.ts 没有调用 shutdownCompanionNode')
    const at = source.indexOf('shutdownCompanionNode()')
    const sigint = source.indexOf("process.on('SIGINT'")
    if (at < 0 || sigint < 0) throw new Error('缺少退出钩子')
    if (at > sigint) throw new Error('回收应在退出钩子之前/之内注册')
    return 'index.ts 已接线'
  })

  /* ---------------- store：卡死回归 ---------------- */
  check('store：worker 被移除时在途任务立刻退回队列（不再等 10 分钟租约）', () => {
    const source = read('apps/server/src/companion/store.ts')
    if (!source.includes('requeueWorkerTasks')) throw new Error('没有 requeueWorkerTasks')
    // 落地到「worker 不在表里」这条判断上
    if (!source.includes('!workers.has(task.workerId)')) {
      throw new Error('缺少「认领它的 worker 已不在表里」的判断——服务端重启后任务会卡在 running')
    }
    const forgetAt = source.indexOf('export function forgetWorkersRegisteredSince')
    if (forgetAt < 0) throw new Error('没有 forgetWorkersRegisteredSince')
    const block = source.slice(forgetAt, forgetAt + 700)
    if (!block.includes('requeueWorkerTasks')) throw new Error('停止节点时没有把在途任务退回队列')
    return 'requeue + 孤儿任务回收'
  })

  /* ---------------- 前端：api 层 ---------------- */
  check('前端 api：getCompanionNode / startCompanionNode / stopCompanionNode', () => {
    const source = read('apps/web/src/lib/api.ts')
    mustInclude('api', source, [
      'export function getCompanionNode',
      'export function startCompanionNode',
      'export function stopCompanionNode',
      'export interface CompanionNodeStatus',
    ], 'lib/api.ts')
    return '3 个函数 + 1 个类型'
  })

  check('前端 api：POST stop 带 body（Fastify 无 body 会 400）', () => {
    const source = read('apps/web/src/lib/api.ts')
    const at = source.indexOf('export function stopCompanionNode')
    if (at < 0) throw new Error('找不到 stopCompanionNode')
    const block = source.slice(at, at + 500)
    if (!block.includes("body: '{}'")) throw new Error('stop 请求没有 body（服务端会 400）')
    return "stop 带 body: '{}'"
  })

  /* ---------------- 前端：UI 钩子 ---------------- */
  check('任务卡：阻塞态有「启动生成节点」按钮且只在可控时出现', () => {
    const source = read('apps/web/src/features/audio/AudioJobCard.tsx')
    if (!source.includes('data-audio-job-start-node')) throw new Error('缺少 data-audio-job-start-node')
    if (!source.includes("job.blockReason === 'start-companion' && nodeCtl.available")) {
      throw new Error('按钮没有做「可控才显示」的降级判断（旧服务端会露出无效按钮）')
    }
    if (!source.includes('useCompanionNode')) throw new Error('没有使用 useCompanionNode')
    return '按钮 + 降级判断'
  })

  check('任务卡：既有自动化钩子没被破坏', () => {
    const source = read('apps/web/src/features/audio/AudioJobCard.tsx')
    mustInclude('AudioJobCard', source, [
      'data-audio-job-command',
      'data-audio-job-install',
      'data-audio-job-cancel',
      '复制启动命令',
      'gen-btn-accent',
      'gen-btn-quiet',
    ], 'AudioJobCard.tsx')
    return '6 个既有钩子/类名都在'
  })

  check('任务卡：启动失败展示服务端原因（data-audio-job-node-error）', () => {
    const source = read('apps/web/src/features/audio/AudioJobCard.tsx')
    if (!source.includes('data-audio-job-node-error')) throw new Error('缺少失败原因容器')
    if (!source.includes('nodeCtl.error')) throw new Error('没有渲染 nodeCtl.error')
    return '失败原因可见'
  })

  check('音频引擎菜单：离线时也能一键启动（data-audio-node-start）', () => {
    const source = read('apps/web/src/features/audio/AudioEngineMenu.tsx')
    if (!source.includes('data-audio-node-start')) throw new Error('缺少 data-audio-node-start')
    if (!source.includes('useCompanionNode')) throw new Error('没有使用 useCompanionNode')
    if (!source.includes('复制启动命令')) throw new Error('复制命令路径被删了（降级路径需要）')
    return '菜单按钮 + 保留复制命令'
  })

  check('audioIntent：模型就绪时先尝试拉起节点，失败才 blocked', () => {
    const source = read('apps/web/src/features/audio/audioIntent.ts')
    if (!source.includes('export async function ensureCompanionOnline')) throw new Error('没有 ensureCompanionOnline')
    const at = source.indexOf('async function checkGenerationReady')
    const block = source.slice(at, at + 3200)
    if (!block.includes('await ensureCompanionOnline()')) throw new Error('checkGenerationReady 没有尝试拉起节点')
    if (!block.includes("reason: 'start-companion'")) throw new Error('失败后没有降级成 blocked/start-companion')
    return '自动拉起 + 降级'
  })

  check('audioIntent：ensureCompanionOnline 对旧服务端不抛异常', () => {
    const source = read('apps/web/src/features/audio/audioIntent.ts')
    const at = source.indexOf('export async function ensureCompanionOnline')
    const block = source.slice(at, at + 900)
    const tryCount = (block.match(/try \{/g) ?? []).length
    if (tryCount < 2) throw new Error('缺少 try/catch 降级（旧服务端 404 会抛未捕获拒绝）')
    return `2 处 try/catch`
  })

  check('hook：refresh 失败时静默降级（不抛未捕获拒绝）', () => {
    const source = read('apps/web/src/features/audio/useCompanionNode.ts')
    const at = source.indexOf('const refresh = useCallback')
    if (at < 0) throw new Error('找不到 refresh')
    const block = source.slice(at, at + 600)
    if (!block.includes('catch')) throw new Error('refresh 没有 catch（旧服务端 404 → 未捕获拒绝）')
    if (!block.includes('setNode(null)')) throw new Error('失败时应把 node 置空（隐藏一键启动按钮）')
    return '静默降级'
  })

  /* ---------------- 文档 ---------------- */
  check('文档：COMPANION.md 有 §4.7 与故障排查行', () => {
    const source = read('docs/COMPANION.md')
    if (!source.includes('### 4.7')) throw new Error('缺少 §4.7')
    if (!source.includes('AIAB_COMPANION_AUTOSTART')) throw new Error('缺少开关说明')
    if (!source.includes('companion-node.log')) throw new Error('缺少日志位置')
    if (!source.includes('启动生成节点')) throw new Error('缺少界面入口说明')
    return '§4.7 + 开关 + 日志 + 排查行'
  })

  check('文档：README 提到一键启动与开关', () => {
    const source = read('README.md')
    if (!source.includes('AIAB_COMPANION_AUTOSTART')) throw new Error('README 缺少开关')
    if (!source.includes('一键启动生成节点')) throw new Error('README 缺少一键启动说明')
    return 'README 已更新'
  })

  console.log('')
  const total = passed + failed
  if (failed === 0) {
    console.log(`${c.green}${c.bold}✓ 全部通过${c.reset}  ${passed}/${total}\n`)
    process.exit(0)
  }
  console.log(`${c.red}${c.bold}✗ ${failed} 项失败${c.reset}  ${passed}/${total} 通过\n`)
  for (const item of failures) console.log(`  ${c.red}•${c.reset} ${item.name}: ${c.dim}${item.message}${c.reset}`)
  console.log('')
  process.exit(1)
}

main().catch((error) => {
  console.error(`\n${c.red}契约验收异常：${error instanceof Error ? error.stack : String(error)}${c.reset}\n`)
  process.exit(1)
})
