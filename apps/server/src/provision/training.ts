/**
 * 训练功能的按需安装与任务编排（P8-C）。
 *
 * 只有用户点「开始训练」才下载/安装：
 *   训练代码包 → 数据集 → 独立 Python → 基座检查点 → venv + pip 依赖 → 训练 → 注册适配器
 *
 * 目录：<dataDir>/training/{code,datasets,python,checkpoints,venv,work,.downloads}
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { downloadFile } from './downloader.js'
import {
  TRAINING_CHECKPOINTS,
  TRAINING_CODE,
  TRAINING_DATASETS,
  TRAINING_PYTHON,
  trainingCheckpointBytes,
  trainingDatasetBytes,
  type TrainingPlatform,
} from './trainingManifest.js'
import { extractTarGz } from './untar.js'

export type TrainingPhase = 'code' | 'datasets' | 'python' | 'checkpoints' | 'env'

/** 检查点目录名 → 界面展示名（训练进度里不暴露真实权重目录名） */
const CHECKPOINT_GROUP_LABELS: Record<string, string> = {
  'Qwen3-Embedding-0.6B': '语义编码器',
  'acestep-v15-turbo': '快速生成模型',
  vae: '音频编解码器',
}

function checkpointGroupLabel(filePath: string): string {
  const group = filePath.split('/')[0] ?? ''
  return CHECKPOINT_GROUP_LABELS[group] ?? '基座检查点'
}

export interface TrainingPaths {
  root: string
  code: string
  datasets: string
  python: string
  checkpoints: string
  venv: string
  work: string
  downloads: string
}

export function trainingPaths(dataDir: string): TrainingPaths {
  const root = path.join(dataDir, 'training')
  return {
    root,
    code: path.join(root, 'code'),
    datasets: path.join(root, 'datasets'),
    python: path.join(root, 'python'),
    checkpoints: path.join(root, 'checkpoints'),
    venv: path.join(root, 'venv'),
    work: path.join(root, 'work'),
    downloads: path.join(root, '.downloads'),
  }
}

function resolveTrainingPlatform(platform?: TrainingPlatform): TrainingPlatform {
  if (platform) return platform
  if (process.platform === 'darwin') return 'darwin-arm64'
  if (process.platform === 'win32') return 'win32-x64'
  return 'linux-x64'
}

function fileSize(target: string): number {
  try {
    return statSync(target).size
  } catch {
    return 0
  }
}

function dirSize(target: string): number {
  if (!existsSync(target)) return 0
  let total = 0
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name)
    total += entry.isDirectory() ? dirSize(full) : fileSize(full)
  }
  return total
}

function venvPythonPath(venv: string, platform: TrainingPlatform): string {
  return platform === 'win32-x64' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python3')
}

function bundledPythonPath(pythonRoot: string, platform: TrainingPlatform): string {
  return platform === 'win32-x64' ? path.join(pythonRoot, 'python', 'python.exe') : path.join(pythonRoot, 'python', 'bin', 'python3')
}

export interface TrainingStatus {
  platform: TrainingPlatform
  phases: Record<TrainingPhase, boolean>
  bytes: { code: number; datasets: number; checkpoints: number; python: number; env: number }
  missingBytes: number
  paths: TrainingPaths
  datasets: { id: string; installed: boolean; size: number }[]
  venvPython: string | null
  notes: string[]
  checkpointBytes: number
  datasetBytes: number
}

export function trainingStatus(options: { dataDir: string; platform?: TrainingPlatform }): TrainingStatus {
  const platform = resolveTrainingPlatform(options.platform)
  const paths = trainingPaths(options.dataDir)
  const codeReady = existsSync(path.join(paths.code, 'training', 'runner.py')) && existsSync(path.join(paths.code, 'acestep', 'training_v2'))
  const datasets = TRAINING_DATASETS.map((dataset) => {
    const dir = path.join(paths.datasets, dataset.id)
    const size = dirSize(dir)
    return { id: dataset.id, installed: size > 0, size }
  })
  const pythonReady = existsSync(bundledPythonPath(paths.python, platform))
  const checkpointsReady = TRAINING_CHECKPOINTS.every((file) => fileSize(path.join(paths.checkpoints, file.dest)) === file.size)
  const venvPython = venvPythonPath(paths.venv, platform)
  const envReady = existsSync(venvPython)
  const phases: Record<TrainingPhase, boolean> = {
    code: codeReady,
    datasets: datasets.every((dataset) => dataset.installed),
    python: pythonReady,
    checkpoints: checkpointsReady,
    env: envReady,
  }
  const missingBytes =
    (codeReady ? 0 : TRAINING_CODE.size) +
    datasets.reduce((sum, dataset) => {
      if (dataset.installed) return sum
      const manifest = TRAINING_DATASETS.find((item) => item.id === dataset.id)
      return sum + (manifest?.size ?? 0)
    }, 0) +
    (checkpointsReady ? 0 : trainingCheckpointBytes()) +
    (pythonReady ? 0 : TRAINING_PYTHON[platform].size)
  const notes: string[] = []
  if (!codeReady) notes.push('训练代码未下载（约 323KB）')
  if (!checkpointsReady) notes.push(`基座检查点未就绪（约 ${(trainingCheckpointBytes() / 1e9).toFixed(1)}GB）`)
  if (!pythonReady) notes.push(`独立 Python 未安装（约 ${(TRAINING_PYTHON[platform].size / 1e6).toFixed(0)}MB）`)
  if (envReady) notes.push('训练环境已就绪（venv）')
  else notes.push('首次训练需创建 venv 并安装依赖（PyTorch 等，约 2–4GB）')
  return {
    platform,
    phases,
    bytes: {
      code: dirSize(paths.code),
      datasets: dirSize(paths.datasets),
      checkpoints: dirSize(paths.checkpoints),
      python: dirSize(paths.python),
      env: dirSize(paths.venv),
    },
    missingBytes,
    paths,
    datasets,
    venvPython: envReady ? venvPython : null,
    notes,
    checkpointBytes: trainingCheckpointBytes(),
    datasetBytes: trainingDatasetBytes(),
  }
}

export interface TrainingProgress {
  phase: TrainingPhase | 'train'
  message: string
  progress: number
}

export interface SetupTrainingOptions {
  dataDir: string
  platform?: TrainingPlatform
  signal?: AbortSignal
  onProgress?: (progress: TrainingProgress) => void
  log?: (message: string) => void
  fetchImpl?: typeof fetch
  /** 测试/高级用法：复用已有代码/检查点/Python，跳过下载与 pip */
  overrides?: { codeDir?: string; checkpointsDir?: string; pythonPath?: string; workDir?: string; datasetDir?: string; shimPath?: string; runnerPath?: string }
}

function extractArchiveTo(archivePath: string, targetDir: string): void {
  const entries = extractTarGz(readFileSync(archivePath))
  for (const [name, data] of entries) {
    const safeName = name.replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!safeName || safeName.startsWith('..') || path.isAbsolute(safeName)) continue
    const destination = path.join(targetDir, safeName)
    if (!destination.startsWith(targetDir)) continue
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, data)
  }
}

async function setupVenv(options: {
  dataDir: string
  pythonExe: string
  platform: TrainingPlatform
  onProgress?: (progress: TrainingProgress) => void
  log?: (message: string) => void
}): Promise<string> {
  const paths = trainingPaths(options.dataDir)
  mkdirSync(paths.work, { recursive: true })
  const logPath = path.join(paths.work, 'env-setup.log')
  const logStream = createWriteStream(logPath, { flags: 'w' })
  const run = (args: string[], label: string): Promise<number> =>
    new Promise((resolve) => {
      options.log?.(`${label}：${options.pythonExe} ${args.join(' ')}`)
      logStream.write(`\n$ ${options.pythonExe} ${args.join(' ')}\n`)
      const child = spawn(options.pythonExe, args, {
        cwd: paths.root,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout?.on('data', (chunk: Buffer) => {
        logStream.write(chunk)
        const last = String(chunk).trim().split('\n').slice(-1)[0]
        if (last) options.log?.(`[${label}] ${last.slice(0, 160)}`)
        options.onProgress?.({ phase: 'env', progress: 0.55, message: `${label}…` })
      })
      child.stderr?.on('data', (chunk: Buffer) => logStream.write(chunk))
      child.on('exit', (code) => resolve(code ?? 1))
      child.on('error', () => resolve(1))
    })
  try {
    options.onProgress?.({ phase: 'env', progress: 0.2, message: '创建 venv…' })
    if ((await run(['-m', 'venv', paths.venv], 'venv')) !== 0) throw new Error(`创建 venv 失败（见 ${logPath}）`)
    const venvPython = venvPythonPath(paths.venv, options.platform)
    options.onProgress?.({ phase: 'env', progress: 0.35, message: '升级 pip…' })
    if ((await run([venvPython, '-m', 'pip', 'install', '--upgrade', 'pip'], 'pip-upgrade')) !== 0) {
      throw new Error(`pip 升级失败（见 ${logPath}）`)
    }
    options.onProgress?.({ phase: 'env', progress: 0.45, message: '安装训练依赖（PyTorch 等，较慢）…' })
    const requirements = path.join(paths.code, 'training', 'requirements.txt')
    if ((await run([venvPython, '-m', 'pip', 'install', '-r', requirements], 'pip-install')) !== 0) {
      throw new Error(`训练依赖安装失败（见 ${logPath}）`)
    }
    return venvPython
  } finally {
    logStream.end()
  }
}

export async function setupTraining(options: SetupTrainingOptions): Promise<TrainingStatus> {
  const platform = resolveTrainingPlatform(options.platform)
  const paths = trainingPaths(options.dataDir)
  for (const dir of [paths.root, paths.code, paths.datasets, paths.python, paths.checkpoints, paths.work, paths.downloads]) {
    mkdirSync(dir, { recursive: true })
  }
  const fetchImpl = options.fetchImpl
  const overrides = options.overrides ?? {}

  // 1) 训练代码
  if (overrides.codeDir) {
    if (!existsSync(path.join(overrides.codeDir, 'training', 'runner.py'))) throw new Error(`override codeDir 缺少 training/runner.py：${overrides.codeDir}`)
    options.onProgress?.({ phase: 'code', progress: 1, message: '复用已有训练代码' })
  } else {
    const archivePath = path.join(paths.downloads, TRAINING_CODE.file)
    await downloadFile({
      url: TRAINING_CODE.url,
      dest: archivePath,
      size: TRAINING_CODE.size,
      sha256: TRAINING_CODE.sha256,
      signal: options.signal,
      fetchImpl,
      onProgress: ({ received, total }) => options.onProgress?.({ phase: 'code', progress: total > 0 ? received / total : 0, message: '下载训练代码包…' }),
    })
    extractArchiveTo(archivePath, paths.code)
    if (!existsSync(path.join(paths.code, 'training', 'runner.py'))) throw new Error('训练代码包解压后缺少 training/runner.py')
    options.onProgress?.({ phase: 'code', progress: 1, message: '训练代码就绪' })
  }
  const codeDir = overrides.codeDir ?? paths.code

  // 2) 检查点
  if (overrides.checkpointsDir) {
    options.onProgress?.({ phase: 'checkpoints', progress: 1, message: '复用已有检查点' })
  } else {
    const totalBytes = trainingCheckpointBytes()
    let doneBytes = 0
    for (const file of TRAINING_CHECKPOINTS) {
      await downloadFile({
        url: file.url,
        dest: path.join(paths.checkpoints, file.dest),
        size: file.size,
        sha256: file.sha256,
        signal: options.signal,
        fetchImpl,
        onProgress: ({ received }) => {
          const ratio = totalBytes > 0 ? (doneBytes + received) / totalBytes : 0
          options.onProgress?.({ phase: 'checkpoints', progress: ratio, message: `下载检查点（${checkpointGroupLabel(file.path)}）…` })
        },
      })
      doneBytes += file.size
    }
    options.onProgress?.({ phase: 'checkpoints', progress: 1, message: '检查点就绪' })
  }

  // 3) 独立 Python
  if (overrides.pythonPath) {
    options.onProgress?.({ phase: 'python', progress: 1, message: '复用已有 Python' })
  } else {
    const pythonAsset = TRAINING_PYTHON[platform]
    const archivePath = path.join(paths.downloads, pythonAsset.file)
    await downloadFile({
      url: pythonAsset.url,
      dest: archivePath,
      size: pythonAsset.size,
      sha256: pythonAsset.sha256,
      signal: options.signal,
      fetchImpl,
      onProgress: ({ received, total }) => options.onProgress?.({ phase: 'python', progress: total > 0 ? received / total : 0, message: '下载独立 Python…' }),
    })
    extractArchiveTo(archivePath, paths.python)
    if (!existsSync(bundledPythonPath(paths.python, platform))) throw new Error('独立 Python 解压后找不到可执行文件')
    options.onProgress?.({ phase: 'python', progress: 1, message: '独立 Python 就绪' })
  }

  // 4) 数据集
  const datasetTotal = trainingDatasetBytes()
  let datasetDone = 0
  for (const dataset of TRAINING_DATASETS) {
    const dir = path.join(paths.datasets, dataset.id)
    if (existsSync(dir) && dirSize(dir) > 0) {
      datasetDone += dataset.size
      continue
    }
    const archivePath = path.join(paths.downloads, dataset.file)
    await downloadFile({
      url: dataset.url,
      dest: archivePath,
      size: dataset.size,
      sha256: dataset.sha256,
      signal: options.signal,
      fetchImpl,
      onProgress: ({ received }) => {
        const ratio = datasetTotal > 0 ? (datasetDone + received) / datasetTotal : 0
        options.onProgress?.({ phase: 'datasets', progress: ratio, message: `下载数据集 ${dataset.id}…` })
      },
    })
    extractArchiveTo(archivePath, paths.datasets)
    datasetDone += dataset.size
  }
  options.onProgress?.({ phase: 'datasets', progress: 1, message: '数据集就绪' })

  // 5) venv
  if (existsSync(venvPythonPath(paths.venv, platform))) {
    options.onProgress?.({ phase: 'env', progress: 1, message: 'venv 已存在' })
  } else if (overrides.pythonPath) {
    options.onProgress?.({ phase: 'env', progress: 1, message: '复用已有 Python（跳过 venv）' })
  } else {
    await setupVenv({ dataDir: options.dataDir, pythonExe: bundledPythonPath(paths.python, platform), platform, onProgress: options.onProgress, log: options.log })
    options.onProgress?.({ phase: 'env', progress: 1, message: '训练环境就绪' })
  }
  return trainingStatus({ dataDir: options.dataDir, platform })
}

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

export interface TrainingJobStep {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  progress: number
  message?: string
}

export interface TrainingJob {
  id: string
  kind: 'setup' | 'train'
  status: 'running' | 'done' | 'failed' | 'canceled'
  steps: TrainingJobStep[]
  progress: number
  tag?: string
  adapterId?: string
  startedAt: number
  updatedAt: number
  error?: string
  logTail?: string
}

const jobs = new Map<string, TrainingJob>()
let activeJobId: string | null = null
let activeAbort: AbortController | null = null
let activeChild: ChildProcess | null = null

function refreshProgress(job: TrainingJob): void {
  if (job.steps.length === 0) return
  const sum = job.steps.reduce((total, step) => {
    if (step.status === 'done' || step.status === 'skipped') return total + 1
    if (step.status === 'running') return total + Math.max(0, Math.min(1, step.progress))
    return total
  }, 0)
  job.progress = Math.round((sum / job.steps.length) * 1000) / 1000
}

export function getTrainingJob(id: string): TrainingJob | null {
  return jobs.get(id) ?? null
}

export function listTrainingJobs(): TrainingJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export function cancelTrainingJob(id: string): boolean {
  if (id !== activeJobId || !activeAbort) return false
  activeAbort.abort()
  activeChild?.kill()
  return true
}

function createJob(kind: 'setup' | 'train', labels: string[], tag?: string): TrainingJob {
  const job: TrainingJob = {
    id: `train_${Date.now().toString(36)}`,
    kind,
    status: 'running',
    steps: labels.map((label) => ({ key: label, label, status: 'pending', progress: 0 })),
    progress: 0,
    tag,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  jobs.set(job.id, job)
  return job
}

function finish(job: TrainingJob, status: TrainingJob['status'], error?: string): void {
  job.status = status
  job.error = error
  job.updatedAt = Date.now()
  refreshProgress(job)
  if (activeJobId === job.id) {
    activeJobId = null
    activeAbort = null
    activeChild = null
  }
}

export interface StartTrainingSetupOptions {
  dataDir: string
  platform?: TrainingPlatform
  overrides?: SetupTrainingOptions['overrides']
  fetchImpl?: typeof fetch
}

export function startTrainingSetup(options: StartTrainingSetupOptions): TrainingJob {
  if (activeJobId) {
    const active = jobs.get(activeJobId)
    if (active?.status === 'running') throw new Error('已有训练/安装任务在进行中，请等待完成或先取消')
  }
  const job = createJob('setup', ['训练代码', '数据集', '独立 Python', '基座检查点', 'venv 与依赖'])
  activeJobId = job.id
  activeAbort = new AbortController()
  const signal = activeAbort.signal
  const labels: Record<string, string> = {
    code: '训练代码',
    datasets: '数据集',
    python: '独立 Python',
    checkpoints: '基座检查点',
    env: 'venv 与依赖',
  }
  const update = (phase: string, progress: number, message: string): void => {
    const step = job.steps.find((item) => item.label === labels[phase])
    if (!step) return
    step.status = progress >= 1 ? 'done' : 'running'
    step.progress = progress
    step.message = message
    refreshProgress(job)
    job.updatedAt = Date.now()
  }
  void (async () => {
    try {
      await setupTraining({
        dataDir: options.dataDir,
        platform: options.platform,
        signal,
        overrides: options.overrides,
        fetchImpl: options.fetchImpl,
        onProgress: ({ phase, progress, message }) => update(phase, progress, message),
        log: (message) => {
          job.logTail = `${job.logTail ?? ''}\n${message}`.slice(-4000)
          job.updatedAt = Date.now()
        },
      })
      for (const step of job.steps) {
        step.status = 'done'
        step.progress = 1
      }
      finish(job, 'done')
    } catch (error) {
      const aborted = signal.aborted
      for (const step of job.steps) if (step.status === 'running') step.status = aborted ? 'skipped' : 'failed'
      finish(job, aborted ? 'canceled' : 'failed', aborted ? '已取消' : error instanceof Error ? error.message : String(error))
    }
  })()
  return job
}

export interface StartTrainingOptions {
  dataDir: string
  datasetId: string
  tag: string
  styleId?: string
  name?: string
  epochs?: number
  rank?: number
  device?: string
  precision?: string
  overrides?: SetupTrainingOptions['overrides']
}

export function startTraining(options: StartTrainingOptions): TrainingJob {
  if (activeJobId) {
    const active = jobs.get(activeJobId)
    if (active?.status === 'running') throw new Error('已有训练/安装任务在进行中，请等待完成或先取消')
  }
  const paths = trainingPaths(options.dataDir)
  const status = trainingStatus({ dataDir: options.dataDir })
  const overrides = options.overrides ?? {}
  const usingOverrides = Boolean(overrides.codeDir && overrides.checkpointsDir && overrides.pythonPath)
  if (!usingOverrides && (!status.phases.code || !status.phases.checkpoints || !status.phases.python || !status.phases.datasets)) {
    throw new Error('训练环境未准备好：请先点「下载并准备训练环境」（或先运行 setup）')
  }
  const dataset = overrides.datasetDir
    ? path.join(overrides.datasetDir, options.datasetId)
    : path.join(paths.datasets, options.datasetId)
  if (!existsSync(dataset)) throw new Error(`数据集未安装：${options.datasetId}`)
  const codeDir = overrides.codeDir ?? paths.code
  const ckptDir = overrides.checkpointsDir ?? status.paths.checkpoints
  const workDir = overrides.workDir ?? paths.work
  const pythonExe = process.env.AIAB_TRAINING_PYTHON || status.venvPython || options.overrides?.pythonPath || null
  const runner = options.overrides?.runnerPath ?? path.join(codeDir, 'training', 'runner.py')
  if (!pythonExe || !existsSync(pythonExe)) throw new Error('找不到训练 Python（先准备训练环境）')
  if (!existsSync(runner)) throw new Error(`找不到训练 runner：${runner}`)
  const job = createJob('train', ['预处理音频', '风格适配器训练', '注册适配器'], options.tag)
  activeJobId = job.id
  activeAbort = new AbortController()
  const signal = activeAbort.signal
  mkdirSync(workDir, { recursive: true })
  mkdirSync(path.join(workDir, 'logs'), { recursive: true })
  const logPath = path.join(workDir, 'logs', `job_${options.tag}.log`)
  const adapterTarget = path.join(options.dataDir, 'adapters', options.tag)
  void (async () => {
    try {
      job.steps[0]!.status = 'running'
      const child = spawn(
        pythonExe,
        [
          runner,
          '--stage', 'all',
          '--dataset', dataset,
          '--tag', options.tag,
          '--epochs', String(options.epochs && options.epochs > 0 ? options.epochs : 120),
          '--rank', String(options.rank && options.rank > 0 ? options.rank : 32),
          '--device', options.device || 'auto',
          '--precision', options.precision || 'auto',
        ],
        {
          cwd: workDir,
          env: {
            ...process.env,
            AIAB_TRAINING_CODE: codeDir,
            AIAB_TRAINING_CKPT: ckptDir,
            AIAB_TRAINING_WORK: workDir,
            AIAB_TRAINING_SHIM: overrides.shimPath ?? path.join(codeDir, 'pyshim'),
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      activeChild = child
      const logStream = createWriteStream(logPath, { flags: 'w' })
      let output = ''
      let doneLine = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = String(chunk)
        output = `${output}${text}`.slice(-8000)
        logStream.write(chunk)
        job.logTail = output.slice(-2000)
        for (const line of text.split('\n')) {
          if (line.includes('TRAINING_DONE')) doneLine = line.trim()
          if (/Epoch|step/i.test(line)) {
            job.steps[0]!.status = 'done'
            job.steps[0]!.progress = 1
            job.steps[1]!.status = 'running'
            job.steps[1]!.message = line.trim().slice(0, 160)
          } else if (/预处理|Preprocessing/i.test(line)) {
            job.steps[0]!.status = 'running'
            job.steps[0]!.message = line.trim().slice(0, 160)
          }
        }
        refreshProgress(job)
        job.updatedAt = Date.now()
      })
      child.stderr?.on('data', (chunk: Buffer) => logStream.write(chunk))
      const code = await new Promise<number>((resolve) => {
        child.on('exit', (codeValue) => resolve(codeValue ?? 1))
        child.on('error', () => resolve(1))
      })
      activeChild = null
      logStream.end()
      job.steps[0]!.status = 'done'
      job.steps[0]!.progress = 1
      if (code !== 0 || !doneLine.includes('TRAINING_DONE')) throw new Error(`训练失败（code=${code}）。日志：${logPath}`)
      job.steps[1]!.status = 'done'
      job.steps[1]!.progress = 1
      job.steps[2]!.status = 'running'
      const match = /output=(.+?)\s+files=/.exec(doneLine)
      const outputDir = match ? match[1] : path.join(workDir, 'out', `${options.tag}_lora`)
      const finalDir = path.join(outputDir, 'final')
      const weights = path.join(finalDir, 'adapter_model.safetensors')
      if (!existsSync(weights)) throw new Error(`训练完成但找不到权重：${weights}`)
      mkdirSync(adapterTarget, { recursive: true })
      for (const fileName of ['adapter_model.safetensors', 'adapter_config.json']) {
        const source = path.join(finalDir, fileName)
        if (existsSync(source)) copyFileSync(source, path.join(adapterTarget, fileName))
      }
      writeFileSync(
        path.join(adapterTarget, 'adapter.json'),
        JSON.stringify(
          {
            id: options.tag,
            name: options.name || `训练风格 ${options.tag}`,
            styleId: options.styleId,
            baseModel: 'turbo',
            tasks: ['text2music', 'cover'],
            format: 'lora-peft',
            license: 'self-generated (trained locally on self-generated dataset)',
            datasetNote: `trained on ${options.datasetId} (self-generated data)`,
            scale: 1.0,
            training: {
              epochs: options.epochs ?? 120,
              rank: options.rank ?? 32,
              dataset: options.datasetId,
              device: options.device ?? 'auto',
              precision: options.precision ?? 'auto',
              trainedAt: new Date().toISOString(),
            },
          },
          null,
          2,
        ),
        'utf8',
      )
      job.adapterId = options.tag
      job.steps[2]!.status = 'done'
      job.steps[2]!.progress = 1
      finish(job, 'done')
    } catch (error) {
      const aborted = signal.aborted
      activeChild?.kill()
      activeChild = null
      for (const step of job.steps) if (step.status === 'running') step.status = aborted ? 'skipped' : 'failed'
      finish(job, aborted ? 'canceled' : 'failed', aborted ? '已取消' : error instanceof Error ? error.message : String(error))
    }
  })()
  return job
}
