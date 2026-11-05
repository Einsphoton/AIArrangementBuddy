import { useEffect, useRef } from 'react'
import { createStarterProject, useStore } from '../store/store'
import { getProject, listProjects, saveProject } from './api'

/**
 * 工程会话：初次加载 + 自动保存 + 全局事件（新建 / 保存）。
 * 服务端不可用时优雅降级为「纯本地内存工程」，不影响编辑与播放。
 */
export function useProjectSession(): void {
  const project = useStore((s) => s.project)
  const saveStatus = useStore((s) => s.saveStatus)
  const loadedRef = useRef(false)
  const lastSavedSerialized = useRef<string>('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* 初次加载：优先恢复服务端最近一次工程 */
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const summaries = await listProjects()
        if (cancelled || summaries.length === 0) return
        const latest = summaries.sort((a, b) => b.updatedAt - a.updatedAt)[0]
        const remote = await getProject(latest.id)
        if (cancelled || !remote?.tracks?.length) return
        useStore.getState().setProject(remote, { dirty: false })
        lastSavedSerialized.current = JSON.stringify(remote)
      } catch {
        /* 服务端不可用：保持本地示例工程 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* 自动保存（防抖 1.5s） */
  useEffect(() => {
    if (saveStatus !== 'dirty') return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const state = useStore.getState()
      const serialized = JSON.stringify(state.project)
      if (serialized === lastSavedSerialized.current) {
        state.setSaveStatus('saved')
        return
      }
      state.setSaveStatus('saving')
      saveProject(state.project)
        .then(() => {
          lastSavedSerialized.current = serialized
          useStore.getState().setSaveStatus('saved')
        })
        .catch(() => useStore.getState().setSaveStatus('error'))
    }, 1500)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [project, saveStatus])

  /* 全局事件：手动保存 / 新建工程 */
  useEffect(() => {
    const onSave = () => {
      const state = useStore.getState()
      state.setSaveStatus('saving')
      saveProject(state.project)
        .then(() => {
          lastSavedSerialized.current = JSON.stringify(state.project)
          useStore.getState().setSaveStatus('saved')
          useStore.getState().pushToast('success', '工程已保存')
        })
        .catch(() => {
          useStore.getState().setSaveStatus('error')
          useStore.getState().pushToast('error', '保存失败：后端未连接')
        })
    }
    const onNew = () => {
      const fresh = createStarterProject()
      fresh.id = `p_${Math.random().toString(36).slice(2, 10)}`
      fresh.name = '未命名工程'
      useStore.getState().setProject(fresh)
      useStore.getState().pushToast('success', '已新建工程')
    }
    window.addEventListener('aiab:save', onSave)
    window.addEventListener('aiab:new-project', onNew)
    return () => {
      window.removeEventListener('aiab:save', onSave)
      window.removeEventListener('aiab:new-project', onNew)
    }
  }, [])
}
