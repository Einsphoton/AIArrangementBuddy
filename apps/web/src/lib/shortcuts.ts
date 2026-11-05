/**
 * 键盘快捷键的统一表示与匹配。
 *
 * 组合键用「规格字符串」描述：`mod+shift+z`、`Space`、`Alt+ArrowUp`。
 * - `mod` 在 macOS 上是 ⌘，其它平台是 Ctrl —— 与产品习惯一致；
 * - 显示时自动换成平台符号（⌘ / ⇧ / ⌥ / ⌃ / Ctrl）。
 *
 * 事件处理仍由各视图/面板注册，本模块只提供匹配与展示工具，
 * 避免把高频、与焦点强相关的交互（钢琴卷帘、文本输入）塞进一个全局 handler。
 */

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function isMacPlatform(): boolean {
  return MAC
}

/** 当前平台的主修饰键显示文本 */
export function modSymbol(): string {
  return MAC ? '⌘' : 'Ctrl'
}

/** 常见键名 → 显示符号 */
const KEY_ALIASES: Record<string, string> = {
  mod: MAC ? '⌘' : 'Ctrl',
  meta: MAC ? '⌘' : 'Win',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  shift: MAC ? '⇧' : 'Shift',
  alt: MAC ? '⌥' : 'Alt',
  option: MAC ? '⌥' : 'Alt',
  enter: '↵',
  return: '↵',
  escape: 'Esc',
  esc: 'Esc',
  backspace: '⌫',
  delete: 'Del',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: '空格',
  tab: 'Tab',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
  '+': '+',
  '=': '=',
  '-': '-',
  '[': '[',
  ']': ']',
  '\\': '\\',
  '/': '/',
  '?': '?',
  '.': '.',
  ',': ',',
}

/** 组合键字符串 → 用于展示的按键数组，例如 `mod+shift+z` → ['⌘','⇧','Z'] */
export function formatCombo(combo: string): string[] {
  return combo
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === '+') return '+'
      const lower = part.toLowerCase()
      if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
      if (part.length === 1) return part.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
}

/** 事件是否发生在文本输入类元素上（此时不应触发单键快捷键） */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

function normalizeKey(key: string): string {
  const lower = key.toLowerCase()
  if (lower === ' ' || lower === 'spacebar') return 'space'
  if (lower === 'esc') return 'escape'
  if (lower === 'del') return 'delete'
  if (lower === 'return') return 'enter'
  return lower
}

/**
 * 事件是否匹配组合键规格。
 *
 * - 单键规格（如 `space`）忽略修饰键检查之外的部分：仍然要求没有额外修饰键，
 *   以免「空格」和「⌘空格」互相误触。
 * - 带修饰键的规格要求修饰键**精确**匹配。
 */
export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  // 允许字面量 "+" 作为键（如 `mod++` 写法难以阅读，这里只支持单独的 `+`）
  const key = parts[parts.length - 1] ?? ''
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const eventKey = normalizeKey(event.key)
  const wantKey = normalizeKey(key)

  if (eventKey !== wantKey) return false
  if (wantMod !== Boolean(event.metaKey || event.ctrlKey)) return false
  if (wantShift !== Boolean(event.shiftKey)) return false
  if (wantAlt !== Boolean(event.altKey)) return false
  return true
}

/** 从事件生成规格字符串（调试用） */
export function eventToCombo(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push('mod')
  if (event.shiftKey) parts.push('shift')
  if (event.altKey) parts.push('alt')
  parts.push(normalizeKey(event.key))
  return parts.join('+')
}
