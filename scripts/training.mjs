#!/usr/bin/env node
/**
 * 训练 CLI（P8-C）：
 *   node scripts/training.mjs status
 *   node scripts/training.mjs setup            # 按需下载 代码/数据集/Python/检查点 + venv（约 7GB+）
 *   node scripts/training.mjs train --dataset jrpg_v1 --tag my_style --style jrpg --epochs 120 --device mps
 *   node scripts/training.mjs jobs
 *   node scripts/training.mjs cancel --id <jobId>
 */
import process from 'node:process'

const args = process.argv.slice(2)
const command = args[0] ?? 'status'
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const server = getArg('server', process.env.AIAB_SERVER || 'http://127.0.0.1:8787').replace(/\/$/, '')

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
function printJob(job) {
  const icon = { pending: '·', running: '▶', done: '✓', failed: '✗', skipped: '-' }
  console.log(`任务 ${job.id} · ${job.kind} · ${job.status} · ${Math.round((job.progress ?? 0) * 100)}%${job.adapterId ? ` · 适配器 ${job.adapterId}` : ''}`)
  for (const step of job.steps ?? []) {
    const pct = step.status === 'running' ? ` ${Math.round((step.progress ?? 0) * 100)}%` : ''
    console.log(`  ${icon[step.status] ?? '?'} ${step.label}${pct}${step.message ? ` · ${step.message}` : ''}`)
  }
  if (job.error) console.log(`错误：${job.error}`)
}

async function waitJob(jobId) {
  let last = ''
  for (;;) {
    const { status, body } = await api(`/api/training/jobs/${jobId}`)
    if (status !== 200) throw new Error(`查询任务失败 HTTP ${status}`)
    const job = body.job
    const line = `${Math.round((job.progress ?? 0) * 100)}%`
    if (line !== last) {
      const running = (job.steps ?? []).find((step) => step.status === 'running')
      console.log(`进度 ${line}${running ? ` · ${running.label}${running.message ? ` · ${running.message}` : ''}` : ''}`)
      last = line
    }
    if (job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

async function main() {
  if (command === 'status') {
    const { status, body } = await api('/api/training/status')
    if (status !== 200) throw new Error(`HTTP ${status}`)
    console.log(`平台：${body.platform}`)
    const phases = body.phases ?? {}
    console.log(`训练代码：${phases.code ? '✓' : '✗'} · 数据集：${phases.datasets ? '✓' : '✗'} · Python：${phases.python ? '✓' : '✗'} · 检查点：${phases.checkpoints ? '✓' : '✗'} · venv：${phases.env ? '✓' : '✗'}`)
    console.log(`已用：代码 ${human(body.bytes.code)} · 数据集 ${human(body.bytes.datasets)} · 检查点 ${human(body.bytes.checkpoints)} · Python ${human(body.bytes.python)} · venv ${human(body.bytes.env)}`)
    console.log(`还需下载约 ${human(body.missingBytes)}（检查点 ${human(body.checkpointBytes)} / 数据集 ${human(body.datasetBytes)}）`)
    for (const dataset of body.datasets ?? []) console.log(`  [${dataset.installed ? '✓' : ' '}] ${dataset.id} ${human(dataset.size)}`)
    for (const note of body.notes ?? []) console.log(`• ${note}`)
    return
  }
  if (command === 'setup') {
    const { status, body } = await api('/api/training/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    if (status !== 200) throw new Error(`${status}: ${body?.error ?? JSON.stringify(body)}`)
    console.log(`安装任务：${body.jobId}（下载可能需要较久，可随时 Ctrl+C 后重新执行继续续传）`)
    const job = await waitJob(body.jobId)
    printJob(job)
    process.exitCode = job.status === 'done' ? 0 : 1
    return
  }
  if (command === 'train') {
    const payload = {
      datasetId: getArg('dataset', 'jrpg_v1'),
      tag: getArg('tag', `style_${Date.now().toString(36)}`),
      styleId: getArg('style', undefined),
      name: getArg('name', undefined),
      epochs: Number(getArg('epochs', '120')),
      rank: Number(getArg('rank', '32')),
      device: getArg('device', 'auto'),
      precision: getArg('precision', 'auto'),
    }
    const { status, body } = await api('/api/training/train', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (status !== 200) throw new Error(`${status}: ${body?.error ?? JSON.stringify(body)}`)
    console.log(`训练任务：${body.jobId}（tag=${payload.tag} dataset=${payload.datasetId}）`)
    const job = await waitJob(body.jobId)
    printJob(job)
    process.exitCode = job.status === 'done' ? 0 : 1
    return
  }
  if (command === 'jobs') {
    const { body } = await api('/api/training/jobs')
    for (const job of body.jobs ?? []) printJob(job)
    return
  }
  if (command === 'cancel') {
    const id = getArg('id')
    if (!id) throw new Error('需要 --id')
    const { status, body } = await api(`/api/training/jobs/${id}/cancel`, { method: 'POST' })
    if (status !== 200) throw new Error(`${status}: ${body?.error ?? JSON.stringify(body)}`)
    console.log('已请求取消')
    return
  }
  console.error('未知命令（status / setup / train / jobs / cancel）')
  process.exitCode = 1
}

main().catch((error) => {
  console.error('训练 CLI 失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})