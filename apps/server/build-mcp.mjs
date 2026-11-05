#!/usr/bin/env node
/**
 * 打包 MCP stdio server -> apps/server/dist/mcp.mjs
 * 供 Codex / DSH / Claude Desktop 用 `node dist/mcp.mjs` 直接启动（无需 tsx）。
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const srcEntry = path.join(serverDir, 'src', 'mcp', 'server.ts')
const outfile = path.join(serverDir, 'dist', 'mcp.mjs')

await build({
  entryPoints: [srcEntry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
})

console.log('✓ mcp bundle -> apps/server/dist/mcp.mjs')
