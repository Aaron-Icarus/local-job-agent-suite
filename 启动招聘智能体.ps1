$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root "招聘智能体\recruitment-agent"
Set-Location -LiteralPath $app

Write-Host "招聘智能体 v1.5 启动器"
Write-Host "项目目录：$app"

if (-not (Test-Path -LiteralPath (Join-Path $app "node_modules\electron\dist\electron.exe"))) {
  Write-Host "首次启动：安装 Electron 依赖..."
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
}

$db = Join-Path $app "data\v1.4\jobs.db"
if (-not (Test-Path -LiteralPath $db)) {
  Write-Host "首次启动：写入演示角色和岗位..."
  & npm run v14:seed-demo
}

$env:V14_DB_PATH = $db
$env:V14_PORT = "4780"
# Electron 进程的 PATH 可能找不到 node，显式传系统 Node 路径，避免后台服务启动失败。
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$env:V14_NODE = $nodeExe
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$electron = Join-Path $app "node_modules\.bin\electron.cmd"

if (Test-Path -LiteralPath $electron) {
  Write-Host "启动桌面客户端..."
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "set ELECTRON_RUN_AS_NODE=&& `"$electron`" . --no-sandbox") -WorkingDirectory $app -WindowStyle Hidden
  Start-Sleep -Seconds 5
  $healthy = $false
  try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:4780/api/health" -UseBasicParsing -TimeoutSec 3
    $healthy = $health.StatusCode -eq 200
  } catch {
    $healthy = $false
  }
  if ($healthy) {
    Write-Host "桌面客户端已启动。"
    exit 0
  }
  Write-Host "桌面客户端未启动，改用浏览器页面..."
}

$port = "4781"
Start-Process -FilePath "node" -ArgumentList "src/v14/cli/serve.js", "--port=$port", "--db=$db" -WorkingDirectory $app -WindowStyle Hidden
Start-Sleep -Seconds 2
Start-Process "http://127.0.0.1:$port"
Write-Host "浏览器页面已打开：http://127.0.0.1:$port"
Write-Host "服务在后台运行；关闭此窗口不会停止服务。"
Start-Sleep -Seconds 2
