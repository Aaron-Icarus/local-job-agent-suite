param(
  [int]$NodeMajor = 22,
  [string]$PnpmVersion = "9.15.9",
  [switch]$SkipDownload,
  [switch]$SkipVendorInstall,
  [switch]$ForceNode,
  [switch]$UseSystemNode
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$packageRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")).Path
$packagesDir = Join-Path $packageRoot "快捷启动\随项目必须的安装包"
$nodeDir = Join-Path $packagesDir "node"
$downloadsDir = Join-Path $packagesDir "_downloads"
$extractDir = Join-Path $packagesDir "_node_extract_tmp"
$corepackHome = Join-Path $packagesDir "corepack"
$pnpmStoreDir = Join-Path $packagesDir "pnpm-store"
$messageVendorSourceDir = Join-Path $packageRoot "消息平台\message-platform\vendor"
$messageVendorRuntimeDir = Join-Path $packagesDir "message-platform-vendor"

function Assert-InsidePackageArea {
  param([string]$PathToCheck)
  $resolved = [System.IO.Path]::GetFullPath($PathToCheck)
  $base = [System.IO.Path]::GetFullPath($packagesDir)
  if (-not $resolved.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作不在安装包目录内的路径：$resolved"
  }
  return $resolved
}

function Ensure-Directory {
  param([string]$PathToCreate)
  $resolved = Assert-InsidePackageArea $PathToCreate
  if (-not (Test-Path -LiteralPath $resolved)) {
    New-Item -ItemType Directory -Path $resolved | Out-Null
  }
  return $resolved
}

function Get-NodeVersion {
  param([string]$NodeExe)
  if (-not (Test-Path -LiteralPath $NodeExe)) { return $null }
  try {
    $version = (& $NodeExe -p "process.versions.node" 2>$null).Trim()
    if (-not $version) { return $null }
    return $version
  } catch {
    return $null
  }
}

function Test-Node224Plus {
  param([string]$NodeExe)
  $version = Get-NodeVersion $NodeExe
  if (-not $version) { return $false }
  return ([version]$version -ge [version]"22.4.0")
}

function Find-SystemNode {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

function Find-SystemPnpm {
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

function Get-ArchitectureName {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($arch -eq "x64") { return "win-x64" }
  if ($arch -eq "arm64") { return "win-arm64" }
  throw "暂不支持当前 CPU 架构：$arch。请手动安装 Node.js 22.4+。"
}

function Download-PortableNode {
  $targetNode = Join-Path $nodeDir "node.exe"
  if (-not $ForceNode -and (Test-Node224Plus $targetNode)) {
    Write-Host ("OK  已存在随包 Node.js：{0} ({1})" -f $targetNode, (Get-NodeVersion $targetNode)) -ForegroundColor Green
    return $targetNode
  }
  if ($SkipDownload) {
    throw "未找到可用的随包 Node.js，且已指定 SkipDownload。请安装 Node.js 22.4+，或去掉 SkipDownload 让脚本自动下载。"
  }

  Ensure-Directory $downloadsDir | Out-Null
  Ensure-Directory $corepackHome | Out-Null
  Ensure-Directory $pnpmStoreDir | Out-Null

  $platform = Get-ArchitectureName
  $baseUrl = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $shaUrl = "$baseUrl/SHASUMS256.txt"

  Write-Host ("正在读取 Node.js 官方校验清单：{0}" -f $shaUrl) -ForegroundColor Cyan
  $shaText = (Invoke-WebRequest -Uri $shaUrl -UseBasicParsing).Content
  $zipName = $null
  $expectedHash = $null
  foreach ($row in ($shaText -split "`n")) {
    $parts = $row.Trim() -split "\s+"
    if ($parts.Count -ge 2 -and $parts[1] -like "node-v*-$platform.zip") {
      $expectedHash = $parts[0].ToLowerInvariant()
      $zipName = $parts[1]
      break
    }
  }
  if (-not $zipName) {
    throw "没有在 Node.js 官方清单中找到 $platform 的 zip 包。"
  }

  $zipPath = Join-Path $downloadsDir $zipName
  $zipUrl = "$baseUrl/$zipName"
  if (-not (Test-Path -LiteralPath $zipPath)) {
    Write-Host ("正在下载 Node.js 便携包：{0}" -f $zipUrl) -ForegroundColor Cyan
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
  } else {
    Write-Host ("OK  已存在下载缓存：{0}" -f $zipPath) -ForegroundColor Green
  }

  $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expectedHash -and $actualHash -ne $expectedHash) {
    throw "Node.js zip SHA256 校验失败。期望：$expectedHash，实际：$actualHash"
  }
  Write-Host "OK  Node.js zip SHA256 校验通过。" -ForegroundColor Green

  $safeExtractDir = Assert-InsidePackageArea $extractDir
  if (Test-Path -LiteralPath $safeExtractDir) {
    Remove-Item -LiteralPath $safeExtractDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $safeExtractDir | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $safeExtractDir -Force
  $expanded = Get-ChildItem -LiteralPath $safeExtractDir -Directory | Where-Object { $_.Name -like "node-v*-$platform" } | Select-Object -First 1
  if (-not $expanded) {
    throw "Node.js zip 解压后未找到预期目录。"
  }

  $safeNodeDir = Assert-InsidePackageArea $nodeDir
  if (Test-Path -LiteralPath $safeNodeDir) {
    Remove-Item -LiteralPath $safeNodeDir -Recurse -Force
  }
  Move-Item -LiteralPath $expanded.FullName -Destination $safeNodeDir
  Remove-Item -LiteralPath $safeExtractDir -Recurse -Force

  if (-not (Test-Node224Plus $targetNode)) {
    throw "Node.js 安装后仍不可用：$targetNode"
  }
  Write-Host ("OK  已准备随包 Node.js：{0} ({1})" -f $targetNode, (Get-NodeVersion $targetNode)) -ForegroundColor Green
  return $targetNode
}

function Prepare-Pnpm {
  param([string]$NodeExe)
  $nodeHome = Split-Path -Parent $NodeExe
  $env:PATH = "$nodeHome;$env:PATH"
  $env:COREPACK_HOME = $corepackHome
  $env:PNPM_HOME = $nodeHome
  $env:PNPM_STORE_DIR = $pnpmStoreDir

  $corepack = Join-Path $nodeHome "corepack.cmd"
  if (-not (Test-Path -LiteralPath $corepack)) {
    throw "当前 Node.js 不包含 corepack：$corepack。请换用 Node.js 22.4+ 官方发行版。"
  }

  Write-Host ("正在启用 pnpm（corepack -> pnpm@{0}）..." -f $PnpmVersion) -ForegroundColor Cyan
  $enableOutput = & $corepack enable --install-directory $nodeHome 2>&1
  if ($LASTEXITCODE -ne 0) {
    $enableOutput = & $corepack enable 2>&1
    if ($LASTEXITCODE -ne 0) { throw "corepack enable 失败。" }
  }
  if ($enableOutput) { $enableOutput | ForEach-Object { Write-Host $_ } }
  $prepareOutput = & $corepack prepare "pnpm@$PnpmVersion" --activate 2>&1
  if ($LASTEXITCODE -ne 0) { throw "corepack prepare pnpm 失败。" }
  if ($prepareOutput) { $prepareOutput | ForEach-Object { Write-Host $_ } }

  $pnpm = Join-Path $nodeHome "pnpm.cmd"
  if (-not (Test-Path -LiteralPath $pnpm)) {
    $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($cmd) { $pnpm = $cmd.Source }
  }
  if (-not (Test-Path -LiteralPath $pnpm)) {
    throw "pnpm 已准备但未找到 pnpm.cmd。"
  }
  $version = (& $pnpm --version).Trim()
  Write-Host ("OK  pnpm 可用：{0} ({1})" -f $pnpm, $version) -ForegroundColor Green
  return $pnpm
}

function Install-MessagePlatformDependencies {
  param([string]$PnpmCommand)
  if ($SkipVendorInstall) {
    Write-Host "已跳过 message-platform/vendor 依赖安装。" -ForegroundColor Yellow
    return
  }
  if (-not (Test-Path -LiteralPath (Join-Path $messageVendorSourceDir "package.json"))) {
    Write-Host ("跳过：未找到 message-platform/vendor/package.json：{0}" -f $messageVendorSourceDir) -ForegroundColor Yellow
    return
  }

  $runtimeDir = Ensure-Directory $messageVendorRuntimeDir
  foreach ($name in @("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")) {
    $source = Join-Path $messageVendorSourceDir $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $runtimeDir $name) -Force
    }
  }

  Write-Host "正在安装消息平台飞书 SDK 依赖到快捷启动依赖区（pnpm install --frozen-lockfile）..." -ForegroundColor Cyan
  Push-Location $runtimeDir
  & $PnpmCommand install --frozen-lockfile
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "pnpm install --frozen-lockfile 失败，退出码：$code" }
  Write-Host ("OK  消息平台 vendor 依赖已准备完成：{0}" -f $runtimeDir) -ForegroundColor Green
}

Write-Host ("分享包根目录：{0}" -f $packageRoot) -ForegroundColor Cyan
Write-Host ("依赖准备目录：{0}" -f $packagesDir) -ForegroundColor Cyan

if ($UseSystemNode) {
  $nodeExe = Find-SystemNode
  if (-not $nodeExe -or -not (Test-Node224Plus $nodeExe)) {
    throw "未找到可用的系统 Node.js 22.4+。请安装 Node.js 22.4+，或改用随包 Node 模式。"
  }
  $pnpmExe = Find-SystemPnpm
  if (-not $pnpmExe) {
    throw "使用本机 Node 模式时，需要本机 PATH 中已有 pnpm。请先安装/启用 pnpm，或改用随包 Node 模式。"
  }
  Ensure-Directory $pnpmStoreDir | Out-Null
  $env:PNPM_STORE_DIR = $pnpmStoreDir
  Write-Host ("OK  使用本机 Node.js：{0} ({1})" -f $nodeExe, (Get-NodeVersion $nodeExe)) -ForegroundColor Green
  Write-Host ("OK  使用本机 pnpm：{0} ({1})" -f $pnpmExe, (& $pnpmExe --version).Trim()) -ForegroundColor Green
} else {
  $nodeExe = Download-PortableNode
  $pnpmExe = Prepare-Pnpm $nodeExe
}
Install-MessagePlatformDependencies $pnpmExe

Write-Host ""
Write-Host "运行环境准备完成。后续可双击：快捷启动\快捷启动脚本\启动控制台.cmd" -ForegroundColor Green
