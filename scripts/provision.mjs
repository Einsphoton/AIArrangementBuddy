#!/usr/bin/env node
/**
 * 本机引擎自动安装 CLI（P8）。
 *
 *   node scripts/provision.mjs status [--server http://127.0.0.1:8787]
 *   node scripts/provision.mjs install --profile essential[,quality,stems] [--server ...]
 *   node scripts/provision.mjs jobs [--server ...]
 *
 * 说明：安装由服务端执行（下载/校验/解压/落盘），CLI 只做触发与进度显示；
 * 首次使用请先把服务端跑起来：node scripts/start.mjs
 */
import process from 'node:process'

const args = process.argv.slice(2)
const command = args[0] ?? 'status'
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const server = getArg('server', process.env.AIAB_SERVER || 'http://127.0.0.1:8787').replace(/\/$/, '')
const json = args.includes('--json')

async function api(pathname, init) {
  const res = await fetch(`${server}${pathname}`, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
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

function printStatus(status) {
  console.log(`平台：${status.platform}`)
  if (status.supported === false) {
    console.log(`⚠ 不支持：${status.error ?? ''}`)
    return
  }
  console.log(`安装目录：${status.root}`)
  console.log(`运行时：${status.runtime.installed ? `已装（${status.runtime.path}）` : '未安装'}`)
  for (const profile of status.profiles ?? []) {
    console.log(`  [${profile.ready ? '✓' : ' '}] ${profile.id.padEnd(9)} ${profile.label} · 需下载 ${humanBytes(profile.downloadBytes)}`)
  }
  const missing = (status.models ?? []).filter((model) => !model.installed)
  const adapters = status.adapters ?? []
  if (adapters.length > 0) {
    const ready = adapters.filter((adapter) => adapter.installed).length
    console.log(`LoRA 适配器：${ready}/${adapters.length} 就绪（自生成数据，共 ${humanBytes(adapters.reduce((sum, adapter) => sum + adapter.expectedBytes, 0))}）`)
    for (const adapter of adapters) console.log(`  [${adapter.installed ? '✓' : ' '}] ${adapter.id} · ${adapter.name}`)
  }
  if (missing.length > 0) {
    console.log(`缺失模型 ${missing.length} 个，约 ${humanBytes(status.missingBytes)}`)
    for (const model of missing) console.log(`  - ${model.name}（${humanBytes(model.expectedBytes)}）`)
  } else {
    console.log('模型：全部就绪')
  }
  if (status.notes?.length) for (const note of status.notes) console.log(`• ${note}`)
}

function printJob(job) {
  const icon = {
    pending: '·',
    running: '▶',
    done: '✓',
    failed: '✗',
    skipped: '-',
  }
  console.log(`任务 ${job.id} · ${job.status} · ${Math.round((job.progress ?? 0) * 100)}%`)
  for (const step of job.steps ?? []) {
    const pct = step.status === 'running' ? ` ${Math.round((step.progress ?? 0) * 100)}%` : ''
    console.log(`  ${icon[step.status] ?? '?'} ${step.label}${pct}${step.message ? ` · ${step.message}` : ''}`)
  }
  if (job.error) console.log(`错误：${job.error}`)
}

async function main() {
  if (command === 'status') {
    const { status, body } = await api('/api/provision/status')
    if (status !== 200) {
      console.error(`请求失败（HTTP ${status}）：${JSON.stringify(body)}`)
      process.exitCode = 1
      return
    }
    if (json) console.log(JSON.stringify(body, null, 2))
    else printStatus(body)
    return
  }

  if (command === 'jobs') {
    const { body } = await api('/api/provision/jobs')
    for (const job of body?.jobs ?? []) printJob(job)
    return
  }

  if (command === 'install') {
    const profiles = getArg('profile', 'essential').split(',').map((item) => item.trim()).filter(Boolean)
    const { status, body } = await api('/api/provision/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles, adapters: !args.includes('--no-adapters') }),
    })
    if (status !== 200) {
      console.error(`启动安装失败（HTTP ${status}）：${body?.error ?? JSON.stringify(body)}`)
      process.exitCode = 1
      return
    }
    const jobId = body.jobId
    console.log(`安装任务已启动：${jobId}（profiles=${profiles.join(',')}）`)
    let last = ''
    for (;;) {
      const res = await api(`/api/provision/jobs/${jobId}`)
      if (res.status !== 200) {
        console.error(`查询失败（HTTP ${res.status}）`)
        process.exitCode = 1
        return
      }
      const job = res.body.job
      const line = `${Math.round((job.progress ?? 0) * 100)}%`
      if (line !== last) {
        const running = (job.steps ?? []).find((step) => step.status === 'running')
        console.log(`进度 ${line}${running ? ` · ${running.label}${running.message ? ` · ${running.message}` : ''}` : ''}`)
        last = line
      }
      if (job.status !== 'running') {
        printJob(job)
        process.exitCode = job.status === 'done' ? 0 : 1
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }

  console.error(`未知命令：${command}（可用：status / install / jobs）`)
  process.exitCode = 1
}

main().catch((error) => {
  console.error('provision 失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})