#!/usr/bin/env node
/**
 * 用 esbuild 把后端打成单文件。
 * @aiab/core 是工作区源码，会被打进 bundle；npm 依赖保持外置（运行时需要 node_modules）。
 */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 运行期需要真实 node_modules 的依赖（其余全部打进 bundle） */
const external = [
  'fastify',
  'fastify/*',
  '@fastify/*',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  'zod',
  'zod/*',
  'tsx',
]

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external,
    sourcemap: true,
    logLevel: 'info',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  })
}

await bundle(
  path.join(root, 'apps/server/src/index.ts'),
  path.join(root, 'apps/server/dist/server.mjs'),
)

// MCP server 独立入口（可选）：存在才打包
const mcpEntry = path.join(root, 'apps/server/src/mcp/server.ts')
if (existsSync(mcpEntry)) {
  await bundle(mcpEntry, path.join(root, 'apps/server/dist/mcp.mjs'))
}

console.log('✓ server bundle 完成 -> apps/server/dist/')
