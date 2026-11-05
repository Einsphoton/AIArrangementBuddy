/** 供应商无关的 SSE 读取器（OpenAI / Anthropic 流式响应都是 text/event-stream）。 */

export interface SseEvent {
  event?: string
  data: string
}

export async function* readSseEvents(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body
  if (!body) throw new Error('服务端未返回流式响应体')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = undefined
      return null
    }
    const event: SseEvent = { event: eventName, data: dataLines.join('\n') }
    dataLines = []
    eventName = undefined
    return event
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line === '') {
          const event = flush()
          if (event) yield event
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
        // 以 ':' 开头的注释 / 其他字段忽略
        index = buffer.indexOf('\n')
      }
    }
    const tail = flush()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}
