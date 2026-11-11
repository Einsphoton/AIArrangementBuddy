/**
 * 代理环境透传（macOS / Windows / Linux 通用）。
 *
 * Node.js 内置 fetch（undici）默认**不读** HTTPS_PROXY / HTTP_PROXY 等环境变量；
 * 只有在进程启动时就带上 NODE_USE_ENV_PROXY=1，undici 才会启用 EnvHttpProxyAgent
 * 并按 NO_PROXY 规则走代理。服务端下载 ACE-Step 运行时 / 模型用的正是内置 fetch，
 * 所以启动脚本要把这个 flag 补进子进程环境，否则国内网络下会只报 "fetch failed"。
 *
 * 注意：NODE_USE_ENV_PROXY 必须在进程启动时存在，运行中再设置无效 —— 改完代理
 * 环境变量后需要重启应用（node scripts/launch.mjs / pnpm dev / pnpm start）。
 *
 * 这里只负责设置环境变量；下载层自身还会识别 macOS 系统代理（scutil --proxy），
 * 二者互补，不冲突。
 */

/** 常见代理环境变量（大小写两种写法都覆盖；ALL_PROXY 对 undici 也生效） */
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

/**
 * 检测代理环境变量，返回命中的变量名（刻意不返回值本身，避免把代理地址里的
 * 账号密码打印到终端 / 日志）。
 *
 * 用户已经显式配置过 NODE_USE_ENV_PROXY（包括设为 "0" 手动关闭）时视为已处理，
 * 返回 null，不覆盖用户的显式选择。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function detectProxyEnv(env = process.env) {
  const current = env.NODE_USE_ENV_PROXY
  if (typeof current === 'string' && current !== '') return null
  for (const key of PROXY_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.trim() !== '') return key
  }
  return null
}

/**
 * 为子进程准备环境变量：检测到代理变量且 NODE_USE_ENV_PROXY 未设置时，
 * 返回 { ...env, NODE_USE_ENV_PROXY: '1' }；否则原样返回。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function proxyAwareChildEnv(env = process.env) {
  return detectProxyEnv(env) ? { ...env, NODE_USE_ENV_PROXY: '1' } : env
}

/**
 * 启动时打印一行 dim 提示（只在真正补 flag 时打印，不打印代理地址）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(message: string) => void} [write] 自定义输出（例如守护进程写入日志文件）
 * @returns {boolean} 是否打印了提示
 */
export function logProxyHint(env = process.env, write = (message) => console.log(`\x1b[2m${message}\x1b[0m`)) {
  const detected = detectProxyEnv(env)
  if (!detected) return false
  write(`[proxy] 检测到 ${detected}，已为服务端子进程启用 NODE_USE_ENV_PROXY=1（下载将自动走代理）`)
  return true
}
