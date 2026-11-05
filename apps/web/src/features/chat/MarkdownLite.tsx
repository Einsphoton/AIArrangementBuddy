import React, { Fragment } from 'react'

/**
 * 轻量 Markdown 渲染：只支持对话里常用的子集（标题 / 列表 / 代码块 / 引用 / 粗体 / 行内代码）。
 * 不引入额外依赖，也不允许 HTML 注入。
 */
export function MarkdownLite({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className="break-words text-[12.5px] leading-[1.72] text-ink [overflow-wrap:anywhere]">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading':
            return (
              <div
                key={index}
                className={
                  block.level <= 2
                    ? 'mb-1.5 mt-3 text-[13.5px] font-semibold tracking-tight text-ink first:mt-0'
                    : 'mb-1 mt-2.5 text-[12.5px] font-semibold text-ink-2 first:mt-0'
                }
              >
                {renderInline(block.text)}
              </div>
            )
          case 'list':
            return (
              <ul key={index} className="my-1.5 space-y-1 pl-4">
                {block.items.map((item, i) => (
                  <li key={i} className="relative">
                    <span className="absolute -left-3.5 top-[0.62em] h-[3px] w-[3px] rounded-full bg-accent/70" />
                    {renderInline(item)}
                  </li>
                ))}
              </ul>
            )
          case 'ordered':
            return (
              <ol key={index} className="my-1.5 space-y-1 pl-4">
                {block.items.map((item, i) => (
                  <li key={i} className="relative">
                    <span className="absolute -left-4 top-0 text-[11px] tabular-nums text-accent/80">{i + 1}.</span>
                    {renderInline(item)}
                  </li>
                ))}
              </ol>
            )
          case 'code':
            return (
              <pre
                key={index}
                className="mono my-2 max-h-64 overflow-auto rounded-lg border border-line bg-bg-soft px-2.5 py-2 text-[11px] leading-relaxed text-ink-2"
              >
                <code>{block.text}</code>
              </pre>
            )
          case 'quote':
            return (
              <blockquote
                key={index}
                className="my-2 border-l-2 border-accent/40 pl-2.5 text-[12px] leading-relaxed text-ink-2"
              >
                {renderInline(block.text)}
              </blockquote>
            )
          case 'hr':
            return <div key={index} className="my-2.5 h-px bg-line" />
          default:
            return (
              <p key={index} className="my-1.5 first:mt-0 last:mb-0">
                {renderInline(block.text)}
              </p>
            )
        }
      })}
    </div>
  )
}

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'ordered'; items: string[] }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'hr' }

function parseBlocks(raw: string): Block[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: string[] | null = null
  let ordered: string[] | null = null
  let code: string[] | null = null
  let quote: string[] | null = null

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
      paragraph = []
    }
    if (list) {
      blocks.push({ type: 'list', items: list })
      list = null
    }
    if (ordered) {
      blocks.push({ type: 'ordered', items: ordered })
      ordered = null
    }
    if (quote) {
      blocks.push({ type: 'quote', text: quote.join(' ') })
      quote = null
    }
  }

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        blocks.push({ type: 'code', text: code.join('\n') })
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      flush()
      code = []
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      if (ordered) {
        flush()
      }
      list = list ?? []
      list.push(bullet[1])
      continue
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (numbered) {
      if (list) {
        flush()
      }
      ordered = ordered ?? []
      ordered.push(numbered[1])
      continue
    }
    const quoted = line.match(/^\s*>\s?(.*)$/)
    if (quoted) {
      quote = quote ?? []
      quote.push(quoted[1])
      continue
    }
    if (list || ordered || quote) flush()
    paragraph.push(line.trim())
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') })
  flush()
  return blocks
}

function renderInline(text: string): React.ReactNode {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g)
  return tokens.map((token, index) => {
    if (!token) return null
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return (
        <strong key={index} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>
      )
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return (
        <code key={index} className="mono rounded bg-surface-3 px-1 py-[1px] text-[11px] text-accent-soft">
          {token.slice(1, -1)}
        </code>
      )
    }
    if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      return (
        <em key={index} className="italic text-ink-2">
          {token.slice(1, -1)}
        </em>
      )
    }
    return <Fragment key={index}>{token}</Fragment>
  })
}
