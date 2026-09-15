#Requires -Version 5.1
<#
  将 x64dbg Automate (green_pepe) 插件安装到指定 x64dbg 的 plugins 目录。
  Cursor / Git Bash 用户请优先用同目录下的 install_automate_plugin.sh（start-2016-with-client.sh 会自动调用）。
  用法:
    powershell -ExecutionPolicy Bypass -File install_automate_plugin.ps1
    powershell -ExecutionPolicy Bypass -File install_automate_plugin.ps1 -X64dbgRoot "D:\...\snapshot_2025-08-19_19-40"
#>
param(
    [string]$X64dbgRoot = "",
    [string]$ReleaseTag = "v0.6.1-green_pepe",
    [string]$ZipName = "release64-0.6.1-green_pepe.zip"
)

$ErrorActionPreference = "Stop"

if (-not $X64dbgRoot) {
    $X64dbgRoot = $env:X64DBG_ROOT
}
if (-not $X64dbgRoot) {
    Write-Host "请设置 -X64dbgRoot 或环境变量 X64DBG_ROOT（snapshot 根目录）" -ForegroundColor Red
    exit 1
}

$x64exe = Join-Path $X64dbgRoot "release\x64\x64dbg.exe"
$plugDir = Join-Path $X64dbgRoot "release\x64\plugins"
if (-not (Test-Path -LiteralPath $x64exe)) {
    Write-Host "未找到: $x64exe" -ForegroundColor Red
    exit 1
}
New-Item -ItemType Directory -Force -Path $plugDir | Out-Null

$url = "https://github.com/dariushoule/x64dbg-automate/releases/download/$ReleaseTag/$ZipName"
$tmp = Join-Path $env:TEMP "h1-x64dbg-automate-$ReleaseTag.zip"
Write-Host "下载: $url"
Invoke-WebRequest -Uri $url -OutFile $tmp

$extract = Join-Path $env:TEMP "h1-x64dbg-automate-extract"
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive -LiteralPath $tmp -DestinationPath $extract -Force

$releaseFolder = Join-Path $extract "Release"
if (-not (Test-Path $releaseFolder)) {
    Write-Host "压缩包内未找到 Release 目录" -ForegroundColor Red
    exit 1
}

Copy-Item -Path (Join-Path $releaseFolder "*") -Destination $plugDir -Force
Write-Host "已复制到: $plugDir"
Write-Host "请确认存在: $(Join-Path $plugDir 'x64dbg-automate.dp64')"
