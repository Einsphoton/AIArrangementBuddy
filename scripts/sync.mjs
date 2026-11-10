#!/usr/bin/env node
/**
 * 云端 / NAS 同步 CLI（P6-B）：通过 HTTP 调用服务端的 /api/sync/*，在机器之间搬运动同包。
 *
 *   node scripts/sync.mjs status --server http://127.0.0.1:8787
 *   node scripts/sync.mjs export --server http://127.0.0.1:8787 --out ./song.aiabsync [--project p_xxx,p_yyy] [--no-assets]
 *   node scripts/sync.mjs import --server http://127.0.0.1:8787 --file ./song.aiabsync
 *
 * 典型两机流程：
 *   A 机导出 → 拷贝 .aiabsync 到 B 机（U 盘 / NAS 共享目录）→ B 机导入。
 *   NAS 拓扑可以直接对同一个 DATA_DIR 跑服务，则不需要本 CLI（见 docs/SYNC.md）。
 *
 * 只依赖 Node 内置能力（fetch / FormData / Blob），不需要 npm 依赖。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_SERVER = process.env.AIAB_SERVER || 'http://127.0.0.1:8787'
const UA = 'aiab-sync-cli/1.0'

function usage() {
  const lines = [
    'AI 编曲伴侣 · 同步 CLI',
    '',
    '用法：',
    '  node scripts/sync.mjs status [--server <url>] [--json]',
    '  node scripts/sync.mjs export [--server <url>] --out <file.aiabsync> [--project <id1,id2>] [--no-assets] [--name <包名>]',
    '  node scripts/sync.mjs import [--server <url>] --file <file.aiabsync>',
    '',
    '选项：',
    '  --server <url>   服务端地址（默认 ' + DEFAULT_SERVER + '，也可用环境变量 AIAB_SERVER）',
    '  --json           以 JSON 输出（status / import）',
    '',
    '示例：',
    '  node scripts/sync.mjs export --out ./demo.aiabsync',
    '  node scripts/sync.mjs import --server http://192.168.1.20:8787 --file ./demo.aiabsync',
  ]
  console.log(lines.join('\n'))
}

function parseArgs(argv) {
  const out = { command: '', flags: {}, rest: [] }
  const takesValue = new Set(['server', 'out', 'project', 'file', 'name'])
  const booleanFlags = new Set(['json', 'no-assets', 'help'])
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      if (!out.command) out.command = token
      else out.rest.push(token)
      continue
    }
    const key = token.slice(2)
    if (booleanFlags.has(key)) {
      out.flags[key] = true
      continue
    }
    if (!takesValue.has(key)) throw new Error(`未知参数：${token}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${token} 缺少取值`)
    out.flags[key] = value
    i++
  }
  return out
}

function serverUrl(flags) {
  return String(flags.server || DEFAULT_SERVER).replace(/\/+$/, '')
}

async function request(url, init, timeoutMs = 300_000) {
  let response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`连不上服务端 ${url}：${reason}（服务是否已启动？端口是否正确？）`)
  }
  return response
}

async function readError(response) {
  try {
    const data = await response.json()
    if (data && typeof data.error === 'string') return data.error
    return JSON.stringify(data)
  } catch {
    try {
      return (await response.text()).slice(0, 500)
    } catch {
      return `HTTP ${response.status}`
    }
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/* ------------------------------ status ------------------------------ */

async function cmdStatus(flags) {
  const response = await request(`${serverUrl(flags)}/api/sync/status`, { headers: { 'user-agent': UA } }, 15_000)
  if (!response.ok) throw new Error(`status 失败（HTTP ${response.status}）：${await readError(response)}`)
  const data = await response.json()
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  console.log(`数据面：${data.dataDir}${data.dataDirSource === 'env' ? `（来自 ${data.dataDirEnvVar}）` : '（默认仓库 data/）'}`)
  console.log(`  可写性  ${data.writable ? '✓ 可写' : `✗ 不可写：${data.writeError ?? '未知原因'}`}`)
  console.log(`  工程    ${data.projects.count} 个 / ${humanBytes(data.projects.bytes)}`)
  console.log(`  资产    ${data.assets.count} 个（${data.assets.files} 个 WAV）/ ${humanBytes(data.assets.bytes)}`)
  console.log(`  适配器  ${data.adapters.dir}（${data.adapters.count} 个${data.adapters.shared ? '，共享目录' : ''}）`)
  console.log(`  同步包  ${data.sync.count} 个 / ${humanBytes(data.sync.bytes)}（${data.sync.dir}）`)
  console.log(`  服务端  v${data.serverVersion} · ${data.platform} · ${data.generatedAt}`)
}

/* ------------------------------ export ------------------------------ */

async function cmdExport(flags) {
  const out = path.resolve(String(flags.out || `aiab-sync-${Date.now()}.aiabsync`))
  const body = {}
  if (flags.project) body.projectIds = String(flags.project).split(',').map((id) => id.trim()).filter(Boolean)
  if (flags['no-assets']) body.includeAssets = false
  if (flags.name) body.name = String(flags.name)

  const response = await request(`${serverUrl(flags)}/api/sync/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）：${await readError(response)}`)

  const type = response.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    const data = await response.json()
    console.log(JSON.stringify(data, null, 2))
    return
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(out, buffer)
  console.log(`✓ 已导出同步包：${out}`)
  console.log(`  大小    ${humanBytes(buffer.length)}（${buffer.length} 字节）`)
  console.log(`  sha256  ${sha256(buffer)}`)
  console.log(
    `  内容    ${response.headers.get('x-sync-projects') ?? '?'} 个工程 / ` +
      `${response.headers.get('x-sync-assets') ?? '?'} 个资产` +
      (Number(response.headers.get('x-sync-warnings') ?? 0) > 0
        ? ` / ${response.headers.get('x-sync-warnings')} 条警告`
        : ''),
  )
  console.log(`  包 ID   ${response.headers.get('x-sync-package-id') ?? '?'}`)
}

/* ------------------------------ import ------------------------------ */

function describeProject(item) {
  const mark = item.action === 'created' ? '+' : item.action === 'renamed' ? '↻' : '='
  const name = item.action === 'renamed' ? `${item.name}（新 id ${item.id}）` : `${item.name}（${item.id}）`
  return `  ${mark} ${name}`
}

async function cmdImport(flags) {
  const file = path.resolve(String(flags.file || ''))
  const buffer = readFileSync(file)
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'application/zip' }), path.basename(file))

  const response = await request(`${serverUrl(flags)}/api/sync/import`, {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: form,
  })
  if (!response.ok) throw new Error(`导入失败（HTTP ${response.status}）：${await readError(response)}`)
  const report = await response.json()
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`✓ ${report.summary}`)
  if (Array.isArray(report.projects) && report.projects.length > 0) {
    console.log('工程：')
    for (const item of report.projects) console.log(describeProject(item))
  }
  console.log(`资产：新增 ${report.assets.added} / 复用 ${report.assets.reused} / 包内共 ${report.assets.total}`)
  if (Array.isArray(report.conflicts) && report.conflicts.length > 0) {
    console.log('冲突：')
    for (const conflict of report.conflicts) {
      console.log(`  ! ${conflict.originalId} → ${conflict.newId}：${conflict.reason}`)
    }
  }
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    console.log('警告：')
    for (const warning of report.warnings) console.log(`  - ${warning}`)
  }
}

/* ------------------------------ main ------------------------------ */

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2))
  if (flags.help || !command) {
    usage()
    process.exit(flags.help ? 0 : 1)
  }
  if (command === 'status') return cmdStatus(flags)
  if (command === 'export') return cmdExport(flags)
  if (command === 'import') return cmdImport(flags)
  throw new Error(`未知命令：${command}（可用：status / export / import）`)
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
