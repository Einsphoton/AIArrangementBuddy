/**
 * 本机生成节点（Companion）状态与启动动作（P15）。
 *
 * 背景：Companion 是独立进程，以前只能手敲命令启动，所以界面上的「生成节点未连接」
 * 会一直停在那里——等再久也不会变，因为进程根本没被拉起。单机形态下服务端可以
 * 自己启动它（见 apps/server/src/companion/supervisor.ts），这个 hook 负责：
 *
 *   - 读节点状态（GET /api/companion/node）
 *   - 一键启动（POST /api/companion/node/start，默认等 12s 覆盖冷启动）
 *   - 把「能不能启动 / 启动中 / 失败原因」收敛成界面直接可用的几个值
 *
 * 降级：旧服务端没有 `/api/companion/node`（404）时 `node` 为 null、`available` 为 false，
 * 界面据此隐藏一键启动按钮，继续走原来的「复制启动命令」，不报错、不刷屏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getCompanionNode,
  startCompanionNode,
  type CompanionNodeStatus,
} from '../../lib/api'

/** 界面点按钮时等待注册的上限：冷启动 + 首次健康检查留余量 */
const START_WAIT_MS = 12_000
/** 状态轮询间隔（节点没起来时给用户「正在重试」的观感） */
const POLL_MS = 4000

export interface CompanionNodeController {
  /** 节点状态快照；旧服务端 / 请求失败时为 null */
  node: CompanionNodeStatus | null
  /** 是否允许「一键启动」（服务端支持且未被 AIAB_COMPANION_AUTOSTART 关闭） */
  available: boolean
  /** 启动请求进行中 */
  starting: boolean
  /** 最近一次启动失败的原因（中文，可直接展示） */
  error: string | null
  /** 刷新状态 */
  refresh: () => Promise<CompanionNodeStatus | null>
  /** 一键启动；返回是否真的上线（online） */
  start: () => Promise<boolean>
}

export interface UseCompanionNodeOptions {
  /** 是否开启状态轮询（例如只在阻塞态需要） */
  poll?: boolean
  /** 启动成功回调（例如自动续跑任务） */
  onStarted?: () => void
}

export function useCompanionNode(options: UseCompanionNodeOptions = {}): CompanionNodeController {
  const { poll = false, onStarted } = options
  const [node, setNode] = useState<CompanionNodeStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const onStartedRef = useRef(onStarted)
  onStartedRef.current = onStarted
  /** start 的进行中标记：ref 供定时器读（避免状态更新延迟导致重复启动） */
  const startingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<CompanionNodeStatus | null> => {
    try {
      const next = await getCompanionNode()
      if (mountedRef.current) setNode(next)
      return next
    } catch {
      // 旧服务端没有 /api/companion/node（404）或后端暂时不可达：
      // 视为「不可一键启动」，界面回退到复制启动命令，绝不抛未捕获的拒绝。
      if (mountedRef.current) setNode(null)
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!poll) return
    const timer = window.setInterval(() => {
      // 启动请求进行中时由 start() 自己刷新，避免两路并发写状态
      if (startingRef.current) return
      if (document.hidden) return
      void refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [poll, refresh])

  const start = useCallback(async (): Promise<boolean> => {
    if (startingRef.current) return false
    startingRef.current = true
    setStarting(true)
    setError(null)
    try {
      const result = await startCompanionNode({ waitMs: START_WAIT_MS })
      if (mountedRef.current) setNode(result.node ?? null)
      if (result.online) {
        onStartedRef.current?.()
        return true
      }
      const reason =
        result.node?.reason ||
        (result.node?.available === false
          ? '当前部署形态无法在本机启动生成节点：请在跑 GPU 的机器上手动执行启动命令。'
          : '生成节点已启动但还没完成注册，请稍后重试。')
      if (mountedRef.current) setError(reason)
      return false
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message ? cause.message : '启动生成节点失败，请稍后重试或手动执行启动命令。'
      if (mountedRef.current) setError(message)
      return false
    } finally {
      startingRef.current = false
      if (mountedRef.current) setStarting(false)
    }
  }, [])

  return {
    node,
    available: node?.controllable === true,
    starting,
    error,
    refresh,
    start,
  }
}
