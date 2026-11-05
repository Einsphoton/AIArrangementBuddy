# =============================================================================
#  AI 编曲伴侣 —— Windows 自动安装 Node.js LTS
#  下载官方 zip 解压到 .runtime\node，不写注册表、不需要管理员权限。
# =============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.runtime'
$nodeDir = Join-Path $runtime 'node'
$tmp = Join-Path $runtime 'tmp'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

New-Item -ItemType Directory -Force -Path $runtime, $tmp | Out-Null

# 判断架构
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
Write-Host "  架构: win-$arch"

# 查询最新 LTS
$version = $null
try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if ($lts) { $version = $lts.version }
} catch {
    Write-Host "  无法查询最新版本，使用兜底版本"
}
if (-not $version) { $version = 'v22.22.0' }

$zipName = "node-$version-win-$arch.zip"
$url = "https://nodejs.org/dist/$version/$zipName"
$zipPath = Join-Path $tmp $zipName

Write-Host "  下载 $url"
try {
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
} catch {
    Write-Host ""
    Write-Host "  下载失败。可以先检查网络，或手动安装 Node.js："
    Write-Host "    - 官网: https://nodejs.org/zh-cn/download"
    Write-Host "    - 或用 winget: winget install OpenJS.NodeJS.LTS"
    Write-Host "  装好后再双击 start-windows.bat。"
    exit 1
}

Write-Host "  解压到 $nodeDir"
if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
$extracted = Join-Path $tmp "node-$version-win-$arch"
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $extracted '*') $nodeDir

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path $nodeExe)) {
    Write-Host "  解压后未找到 node.exe，安装失败"
    exit 1
}

Write-Host "  完成: $(& $nodeExe --version)"
exit 0
