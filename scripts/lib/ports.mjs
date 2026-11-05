/**
 * 端口工具：找可用端口，避免「端口被占用」导致启动失败。
 * （开发机上 8787 / 5183 常常被别的项目占着）
 */
import net from 'node:net'

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/** 从 preferred 开始向上找，返回第一个可用端口；都不可用则回退 preferred */
export async function pickFreePort(preferred, host = '127.0.0.1', maxTries = 40) {
  for (let i = 0; i < maxTries; i++) {
    const port = preferred + i
    if (port > 65535) break
    if (await isPortFree(port, host)) return port
  }
  return preferred
}
