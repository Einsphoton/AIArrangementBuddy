import { useCallback, useEffect, useRef } from 'react'

interface DragHandlers {
  onMove: (event: PointerEvent) => void
  onUp?: (event: PointerEvent) => void
  /** 指针被系统打断（pointercancel）时的收尾：清理 rAF / 临时 UI */
  onCancel?: () => void
}

/**
 * 指针拖拽：按下后把 pointermove / pointerup 挂到 window 上。
 *
 * 好处是拖出元素外也不丢事件，且一次手势只会有一对监听；
 * 组件卸载时会自动 abort，避免泄漏。
 */
export function usePointerDrag() {
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    },
    [],
  )

  return useCallback((event: React.PointerEvent, handlers: DragHandlers) => {
    if (event.button !== 0) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const { signal } = controller

    window.addEventListener('pointermove', handlers.onMove, { signal })
    window.addEventListener(
      'pointerup',
      (upEvent) => {
        handlers.onUp?.(upEvent)
        controller.abort()
      },
      { signal, once: true },
    )
    window.addEventListener('pointercancel', () => {
      handlers.onCancel?.()
      controller.abort()
    }, { signal, once: true })
  }, [])
}
