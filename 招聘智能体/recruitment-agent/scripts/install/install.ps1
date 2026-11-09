param([string]$Target = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$source = Join-Path $PSScriptRoot "招聘智能体"
if (-not (Test-Path -LiteralPath $source)) { throw "缺少程序目录：$source" }
if ([string]::IsNullOrWhiteSpace($Target)) {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "选择招聘智能体安装文件夹"
  $dialog.SelectedPath = (Join-Path $env:LOCALAPPDATA "Programs\招聘智能体")
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
  $Target = $dialog.SelectedPath
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$resolvedSource = (Resolve-Path -LiteralPath $source).Path
$resolvedTarget = (Resolve-Path -LiteralPath $Target).Path
if ($resolvedSource -eq $resolvedTarget) {
  Start-Process -FilePath (Join-Path $Target "招聘智能体.exe") -WorkingDirectory $Target
  exit 0
}
Write-Host "正在复制程序到：$Target ..."
Copy-Item -Path (Join-Path $source "*") -Destination $Target -Recurse -Force
Write-Host "复制完成，正在创建快捷方式..."
$exe = Join-Path $Target "招聘智能体.exe"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "招聘智能体.lnk"))
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $Target
$shortcut.IconLocation = $exe
$shortcut.Save()
$start = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\招聘智能体.lnk"
$shortcut2 = $shell.CreateShortcut($start)
$shortcut2.TargetPath = $exe
$shortcut2.WorkingDirectory = $Target
$shortcut2.IconLocation = $exe
$shortcut2.Save()
Start-Process -FilePath $exe -WorkingDirectory $Target