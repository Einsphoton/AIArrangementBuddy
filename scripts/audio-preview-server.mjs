/**
 * 试听页静态服务（只读）：把 music-gen/lora-data 通过 HTTP 提供，
 * 避免 file:// 预览沙箱导致 <audio> 全部灰掉。
 *
 *   node scripts/audio-preview-server.mjs [--port 8908] [--root music-gen/lora-data]
 *
 * 打开 http://127.0.0.1:8908/ 会得到目录列表（音频可直接播放），
 * 也可以直接打开 http://127.0.0.1:8908/quality-matrix/compare.html
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const ROOT = path.resolve(getArg('root', path.join(process.cwd(), 'music-gen', 'lora-data')))
const PORT = Number(getArg('port', '8908'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const cleaned = path.normalize(decoded).replace(/^([/\\])+/, '')
  const full = path.resolve(root, cleaned)
  if (!full.startsWith(root)) return null
  return full
}

function listPage(dir, urlPath) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  const parent = urlPath === '/' ? '' : `<p><a href="../">↑ 上一级</a></p>`
  const rows = entries
    .map((e) => {
      const name = encodeURIComponent(e.name)
      const childPath = `${urlPath.replace(/\/$/, '')}/${name}`
      if (e.isDirectory()) return `<li>📁 <a href="${childPath}/">${e.name}/</a></li>`
      const ext = path.extname(e.name).toLowerCase()
      if (ext === '.wav' || ext === '.mp3') {
        return `<li>🎵 <a href="${childPath}">${e.name}</a><br><audio controls preload="metadata" src="${childPath}"></audio></li>`
      }
      return `<li>📄 <a href="${childPath}">${e.name}</a></li>`
    })
    .join('\n')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>试听 ${urlPath}</title>
<style>body{background:#111;color:#eee;font:15px/1.7 system-ui;margin:2rem auto;max-width:1100px;padding:0 1rem}
a{color:#9cdcfe}audio{width:320px;height:34px}li{margin:.4rem 0}</style>
<h1>试听目录：${urlPath}</h1>${parent}<ul>${rows}</ul></body></html>`
}

const server = createServer((req, res) => {
  const urlPath = req.url ?? '/'
  const full = safeJoin(ROOT, urlPath)
  if (!full || !existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404')
    return
  }
  const stat = statSync(full)
  if (stat.isDirectory()) {
    const dirUrl = urlPath.endsWith('/') ? urlPath : `${urlPath}/`
    if (dirUrl !== urlPath) {
      res.writeHead(302, { Location: dirUrl }).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(listPage(full, dirUrl))
    return
  }
  const ext = path.extname(full).toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Number(m[2]) : stat.size - 1
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
    })
    createReadStream(full, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  })
  createReadStream(full).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`试听服务已启动：http://127.0.0.1:${PORT}/`)
  console.log(`  root = ${ROOT}`)
  console.log(`  对比页：http://127.0.0.1:${PORT}/quality-matrix/compare.html`)
})