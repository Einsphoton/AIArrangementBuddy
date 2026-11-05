@echo off
rem ============================================================================
rem  AI 编曲伴侣 —— Windows 一键启动（双击即可，不需要 Docker）
rem
rem  首次运行会自动：
rem    1. 检测 Node.js，缺失则下载官方 LTS 到 .runtime\node（免管理员权限）
rem    2. 检测依赖，缺失则自动安装
rem    3. 启动前后端并打开浏览器
rem
rem  生产模式：start-windows.bat --prod
rem ============================================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PATH=%CD%\.runtime\node;%PATH%"
set "NODE_OK=0"

where node >nul 2>nul && set "NODE_OK=1"

if "!NODE_OK!"=="0" (
  echo.
  echo 未检测到 Node.js，正在自动安装到项目目录（约 30MB）...
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bootstrap-node.ps1"
  if errorlevel 1 goto :fail
  set "PATH=%CD%\.runtime\node;%PATH%"
)

node --version >nul 2>nul
if errorlevel 1 goto :fail

echo.
echo  ============================================
echo    AI 编曲伴侣 · AI Arrangement Buddy
echo  ============================================
echo.

node scripts\launch.mjs %*
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo 启动失败。请把上面的报错信息发给开发者，或手动执行：
echo    cd /d "%CD%"
echo    node scripts\launch.mjs
echo.
pause
exit /b 1
