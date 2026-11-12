#!/usr/bin/env node
/**
 * 本机自检（macOS / Windows / Linux 通用）：
 *   node scripts/self-check.mjs [--server http://127.0.0.1:8787]
 *
 * 检查：Node 版本、平台、数据目录可写、引擎/模型安装状态、Companion 是否在线、适配器数量。
 * 只读检查，不触发下载。
 */
import { statfsSync } from 'node:fs'
import process from 'node:process'

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const server = getArg('server', process.env.AIAB_SERVER || 'http://127.0.0.1:8787').replace(/\/$/, '')

async function api(pathname) {
  try {
    const res = await fetch(`${server}${pathname}`)
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, body: await res.json() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function human(bytes) {
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

console.log('ArrangementBuddy 本机自检')
console.log(`  Node      : ${process.version}（要求 >= 20.19）`)
console.log(`  平台      : ${process.platform}/${process.arch}`)

const provision = await api('/api/provision/status')
if (!provision.ok) {
  console.log(`  服务端    : ✗ 无法连接 ${server}（${provision.error ?? `HTTP ${provision.status}`}）`)
  console.log('  下一步    : 先运行 node scripts/start.mjs，再打开 http://127.0.0.1:8787')
  process.exitCode = 1
} else {
  const status = provision.body
  console.log(`  服务端    : ✓ ${server}`)
  console.log(`  引擎平台  : ${status.platform}${status.supported === false ? `（不支持自动安装：${status.error ?? ''}）` : ''}`)
  console.log(`  安装目录  : ${status.root ?? '-'}`)
  console.log(`  运行时    : ${status.runtime?.installed ? '✓ 已安装' : '✗ 未安装'}`)
  const profiles = status.profiles ?? []
  for (const profile of profiles) {
    console.log(`  [${profile.ready ? '✓' : ' '}] ${String(profile.id).padEnd(9)} ${profile.label} · 需下载 ${human(profile.downloadBytes)}`)
  }
  if (!status.runtime?.installed || profiles.some((profile) => !profile.ready && profile.id === 'essential')) {
    console.log('  下一步    : 网页点「安装本机引擎」，或运行：')
    console.log('             node scripts/provision.mjs install --profile essential[,quality,stems]')
  }
  try {
    const stat = statfsSync(status.root ?? '.')
    console.log(`  磁盘可用  : ${human(Number(stat.bavail) * Number(stat.bsize))}`)
  } catch {
    /* 某些平台取不到磁盘信息，忽略 */
  }
}

const companion = await api('/api/companion/status')
if (companion.ok) {
  const online = companion.body?.online === true
  const workers = companion.body?.workers ?? []
  console.log(`  Companion : ${online ? `✓ 在线（${workers.length} 个 worker）` : '✗ 离线'}`)
  if (!online) {
    console.log('  下一步    : node scripts/companion.mjs --server ' + server + ' --engine --engine-idle 600')
  }
} else {
  console.log('  Companion : ? 无法查询')
}

const adapters = await api('/api/adapters')
if (adapters.ok) {
  const body = adapters.body
  console.log(`  适配器    : ${body.count ?? 0} 个（可上运行时 ${(body.nativeReady ?? []).length} 个）`)
}

console.log('')