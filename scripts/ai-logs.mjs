#!/usr/bin/env node
/**
 * 查看 AI 生成运行日志（data/logs/ai-runs-*.jsonl）。
 *
 *   node scripts/ai-logs.mjs                 # 最近 10 次运行摘要
 *   node scripts/ai-logs.mjs --failed        # 只看有失败的（运行失败 / 工具调用失败）
 *   node scripts/ai-logs.mjs --limit 30      # 最近 30 次
 *   node scripts/ai-logs.mjs --run run_xxxx  # 指定 run
 *   node scripts/ai-logs.mjs --json          # 输出原始 JSON（便于脚本处理）
 *   DATA_DIR=/path/to/data node scripts/ai-logs.mjs
 *
 * 日志会记录每次 /api/ai/chat 的工具调用（含失败原因与参数摘要）、
 * 服务商重试、token 消耗、输出是否被 max_tokens 截断、最终工程质量自检。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.DATA_DIR || process.env.AIAB_DATA_DIR || path.join(root, 'data')
const logsDir = path.join(dataDir, 'logs')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1 || index + 1 >= args.length) return fallback
  return args[index + 1]
}

const jsonMode = flag('json')
const failedOnly = flag('failed')
const limit = Math.max(1, Number(option('limit', '10')) || 10)
const runId = option('run', '')

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gold: '\x1b[33m',
  bold: '\x1b[1m',
}

const dayMs = 24 * 60 * 60 * 1000
const retentionNote = '（日志保留最近 14 天、单文件 8MB，位于 data/logs/）'

function listFiles() {
  let names
  try {
    names = readdirSync(logsDir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith('ai-runs-') && name.endsWith('.jsonl'))
    .map((name) => ({ name, full: path.join(logsDir, name), stat: statSync(path.join(logsDir, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
}

function readEntries(files) {
  const entries = []
  for (const file of files) {
    if (file.stat.mtimeMs < Date.now() - 14 * dayMs) continue
    let text
    try {
      text = readFileSync(file.full, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        /* 忽略坏行 */
      }
    }
  }
  return entries
}

function outcomeLabel(entry) {
  const failed = entry.outcome !== 'ok' || entry.toolFailureCount > 0
  const color = entry.outcome === 'ok' ? C.green : C.red
  const tags = [`${color}${entry.outcome}${C.reset}`]
  if (entry.toolCallCount) tags.push(`工具 ${entry.toolCallCount - (entry.toolFailureCount || 0)}/${entry.toolCallCount}`)
  if (entry.toolFailureCount) tags.push(`${C.red}失败 ${entry.toolFailureCount}${C.reset}`)
  if ((entry.providerCalls || []).some((call) => call.escalated)) tags.push('自动加预算')
  if ((entry.providerCalls || []).some((call) => call.truncated)) tags.push(`${C.gold}截断${C.reset}`)
  if (entry.quality) tags.push(`质量 ${entry.quality.issueCount ? C.gold : C.green}${entry.quality.issueCount}${C.reset}`)
  return { failed, text: tags.join(' · ') }
}

function printEntry(entry) {
  const { text } = outcomeLabel(entry)
  const when = entry.startedAt ? new Date(entry.startedAt).toLocaleString('zh-CN', { hour12: false }) : '?'
  console.log(`${C.bold}${entry.runId}${C.reset}  ${when}  intent=${entry.intent ?? '-'}  ${text}`)
  console.log(
    `${C.dim}  ${entry.projectName ?? entry.projectId ?? '-'} · ${((entry.elapsedMs || 0) / 1000).toFixed(1)}s · ` +
      `tokens in/out ${entry.usage?.inputTokens ?? '?'}/${entry.usage?.outputTokens ?? '?'} · ` +
      `text ${entry.textChars ?? 0} 字 · reasoning ${entry.reasoningChars ?? 0} 字${C.reset}`,
  )
  if (entry.error) console.log(`${C.red}  错误：${entry.error}${C.reset}`)
  for (const call of (entry.toolCalls || []).filter((item) => !item.ok)) {
    console.log(`${C.red}  ✗ ${call.name}${C.reset} ${C.dim}${call.args ?? ''}${C.reset}`)
    console.log(`    ${call.error ?? ''}`)
  }
  for (const call of (entry.providerCalls || []).filter((item) => item.escalated || item.truncated)) {
    console.log(
      `${C.gold}  预算：第 ${call.round} 轮 max_tokens=${call.maxTokens ?? '?'}${call.escalated ? '（自动加大）' : ''}` +
        `${call.truncated ? ' · 被截断' : ''}${C.reset}`,
    )
  }
  for (const retry of entry.providerRetries || []) {
    console.log(
      `${C.gold}  重试：第 ${retry.round} 轮第 ${retry.attempt} 次 · HTTP ${retry.status ?? 'network'} · 等 ${retry.delayMs}ms${C.reset}`,
    )
  }
  if (entry.quality && entry.quality.issueCount > 0) {
    console.log(`${C.gold}  质量自检（${entry.quality.high} 高 / ${entry.quality.medium} 中 / ${entry.quality.low} 低）：${C.reset}`)
    for (const issue of entry.quality.issues || []) console.log(`    - [${issue.severity}] ${issue.message}`)
    if (entry.qualityRepair?.triggered) {
      console.log(`    ${C.dim}自动修复：${entry.qualityRepair.repaired ? '已修复' : '仍存在'}（${entry.qualityRepair.issueCount} 项）${C.reset}`)
    }
  }
  if (entry.textPreview) console.log(`${C.dim}  回复片段：${entry.textPreview.slice(-260)}${C.reset}`)
  if (entry.reasoningPreview) console.log(`${C.dim}  思考片段：${entry.reasoningPreview.slice(0, 240)}${C.reset}`)
  console.log('')
}

const files = listFiles()
if (files.length === 0) {
  console.log(`\n${C.gold}还没有 AI 运行日志${C.reset} ${retentionNote}`)
  console.log(`${C.dim}生成一次后会自动出现在 ${logsDir}${C.reset}\n`)
  process.exit(0)
}

const entries = readEntries(files)
  .filter((entry) => !failedOnly || entry.outcome !== 'ok' || (entry.toolFailureCount || 0) > 0)
  .reverse()
  .slice(0, limit)

if (jsonMode) {
  console.log(JSON.stringify(entries, null, 2))
  process.exit(0)
}

console.log(`\n${C.gold}${C.bold}AI 生成运行日志${C.reset} ${C.dim}${retentionNote}${C.reset}`)
console.log(`${C.dim}目录 ${logsDir} · 文件 ${files.length} 个 · 显示 ${entries.length} 条${failedOnly ? '（仅失败）' : ''}${C.reset}\n`)
if (entries.length === 0) {
  console.log(`${C.green}✓ 最近没有失败记录${C.reset}\n`)
  process.exit(0)
}
for (const entry of entries) printEntry(entry)

const failedCount = entries.filter((entry) => entry.outcome !== 'ok' || (entry.toolFailureCount || 0) > 0).length
if (failedCount > 0) {
  console.log(`${C.red}✗ ${failedCount} 条有问题的运行${C.reset}（换一个端口/环境可用 DATA_DIR 指定数据目录）\n`)
} else {
  console.log(`${C.green}✓ 显示的运行全部正常${C.reset}\n`)
}
