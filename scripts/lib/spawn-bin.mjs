/**
 * 跨平台可执行文件启动封装（Windows 兼容）。
 *
 * 项目里的工具链都直接调用 node_modules/.bin 下的可执行文件，以便不依赖全局
 * pnpm。这在 Windows 上有两个坑：
 *
 *  1. .bin 下实际是 .cmd / .bat shim，Node.js 20+ 不允许不带 shell 直接 spawn
 *     （会抛 EINVAL: spawn EINVAL）；
 *  2. 反过来打开 shell:true 时，Node 只是把 command 和 args 用空格拼成一行，
 *     项目路径一旦含空格（如 "D:\AI Project\..."），命令就会被截断，
 *     典型报错是 `'D:\AI' 不是内部或外部命令`。
 *
 * 这里统一处理：Windows 上的 .cmd/.bat 通过 cmd.exe /d /s /c 执行，并对每个
 * 参数显式加引号；其余情况等价于原生 spawn / spawnSync。
 */
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

export const IS_WINDOWS = process.platform === 'win32'

/** .cmd / .bat 需要经由 cmd.exe 执行 */
const BATCH_FILE = /\.(cmd|bat)$/i

/** 需要交给 cmd.exe 时对单个参数加引号（路径为空格的常见场景） */
function quoteForCmd(value) {
  const text = String(value)
  if (text === '') return '""'
  if (!/[\s"&|<>^()]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/** 拼出 cmd.exe 所需的 argv（windowsVerbatimArguments 下由我们负责全部引号） */
function cmdInvocation(command, args, options) {
  const { shell: _ignoredShell, ...rest } = options
  const line = [command, ...args].map(quoteForCmd).join(' ')
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    // 由上面的 line 自行负责引号，禁止 Node 二次转义（cmd 不认反斜杠转义）
    options: { ...rest, shell: false, windowsVerbatimArguments: true },
  }
}

/** 同 child_process.spawn，但兼容 Windows 的 .cmd/.bat 与含空格路径 */
export function spawnBin(command, args = [], options = {}) {
  if (!IS_WINDOWS || !BATCH_FILE.test(command)) {
    const { shell: _ignoredShell, ...rest } = options
    return spawn(command, args, rest)
  }
  const invocation = cmdInvocation(command, args, options)
  return spawn(invocation.command, invocation.args, invocation.options)
}

/** 同 child_process.spawnSync，但兼容 Windows 的 .cmd/.bat 与含空格路径 */
export function spawnBinSync(command, args = [], options = {}) {
  if (!IS_WINDOWS || !BATCH_FILE.test(command)) {
    const { shell: _ignoredShell, ...rest } = options
    return spawnSync(command, args, rest)
  }
  const invocation = cmdInvocation(command, args, options)
  return spawnSync(invocation.command, invocation.args, invocation.options)
}
