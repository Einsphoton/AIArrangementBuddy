/**
 * HTML 解析与 MIDI 识别的小工具（不引入 HTML 解析库，够用即可）。
 */

/** 从 HTML 中抽出绝对化后的链接 */
export function extractLinks(html, baseUrl) {
  const urls = new Set()
  const re = /(?:href|src)\s*=\s*["']([^"'#]+)["']/gi
  let match
  while ((match = re.exec(html))) {
    const raw = match[1].trim()
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('data:')) continue
    try {
      urls.add(new URL(raw, baseUrl).href)
    } catch {
      // 忽略非法 URL
    }
  }
  return [...urls]
}

export function isMidiUrl(url) {
  return /\.(mid|midi|rmi)(\?|$)/i.test(url)
}

/** 按文件头判断是不是标准 MIDI / RIFF MIDI，防止把 HTML 错误页当成 .mid 存下来 */
export function looksLikeMidi(buffer) {
  if (buffer.length < 14) return false
  if (buffer.subarray(0, 4).toString('latin1') === 'MThd') return true
  // RIFF RMID
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'RMID') return true
  return false
}

/** 文件名安全化：去掉查询串、非法字符，保留可读部分 */
export function safeFileName(url) {
  try {
    const target = new URL(url)
    const base = decodeURIComponent(target.pathname.split('/').filter(Boolean).pop() ?? 'file.mid')
    return base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-120)
  } catch {
    return 'file.mid'
  }
}

/** URL 归一化：去 fragment、去末尾多余的 index 默认页，用于去重 */
export function normalizeUrl(url) {
  try {
    const target = new URL(url)
    target.hash = ''
    return target.href
  } catch {
    return url
  }
}
