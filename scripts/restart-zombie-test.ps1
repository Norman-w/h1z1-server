# Run manually with PowerShell 7. This script does not change security settings.
# It restarts only the currently identified demo server; it does not close the game.
param([int]$TargetProcessId = 26900)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'PowerShell 7 is required. Use the command provided in the conversation.'
}
$repositoryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pythonPath = 'C:\Python312\python.exe'
$snapshotCode = @'
import json, psutil, sys
p = psutil.Process(int(sys.argv[1]))
print(json.dumps(dict(exe=p.exe(), cwd=p.cwd(), args=p.cmdline(),
                     env=p.environ(), created=p.create_time())))
'@
# Keep inherited environment values in memory only; never print or save them.
$snapshotJson = & $pythonPath -c $snapshotCode $TargetProcessId
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the original server. Nothing was stopped.' }
$serverSnapshot = $snapshotJson | ConvertFrom-Json
if ([IO.Path]::GetFullPath($serverSnapshot.cwd) -ne $repositoryPath -or
    $serverSnapshot.exe -ne 'C:\Program Files\nodejs\node.exe' -or
    $serverSnapshot.args.Count -ne 4 -or
    $serverSnapshot.args[1] -ne '--no-warnings' -or
    $serverSnapshot.args[2] -ne '--experimental-require-module' -or
    $serverSnapshot.args[3] -ne 'scripts/h1z1-server-demo-2016.js') {
    throw 'Process identity or startup arguments changed. Nothing was stopped.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repositoryPath 'out\servers\ZoneServer2016\zoneserver.js'))) {
    throw 'Compiled server is missing. Nothing was stopped.'
}
$apiPort = if ($serverSnapshot.env.DEV_HTTP_PORT) { [int]$serverSnapshot.env.DEV_HTTP_PORT } else { 13371 }
$clientsUrl = "http://127.0.0.1:$apiPort/api/clients"
$clientState = Invoke-RestMethod $clientsUrl -TimeoutSec 5
if ($null -eq $clientState.clients -or @($clientState.clients).Count -ne 0) {
    throw 'Players are connected, or client status is unknown. Nothing was stopped.'
}
$restartEnvironment = @{}
$serverSnapshot.env.psobject.Properties | ForEach-Object {
    $restartEnvironment[$_.Name] = [string]$_.Value
}
$logDirectory = Join-Path ([IO.Path]::GetTempPath()) ('h1z1-manual-reload-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logDirectory | Out-Null
$originalProcess = Get-Process -Id $TargetProcessId
if ([Math]::Abs(([DateTimeOffset]$originalProcess.StartTime).ToUnixTimeSeconds() - $serverSnapshot.created) -gt 2) {
    throw 'PID was reused. Nothing was stopped.'
}
Write-Host "Restarting demo server PID $TargetProcessId. Logs: $logDirectory"
Stop-Process -Id $TargetProcessId
if (-not $originalProcess.WaitForExit(10000)) { throw 'Original server did not exit; replacement was not started.' }
$newServer = Start-Process -FilePath $serverSnapshot.exe -ArgumentList @($serverSnapshot.args | Select-Object -Skip 1) `
    -WorkingDirectory $repositoryPath -Environment $restartEnvironment -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDirectory 'stdout.log') `
    -RedirectStandardError (Join-Path $logDirectory 'stderr.log') -PassThru
Write-Host "New server PID: $($newServer.Id)"
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    $newServer.Refresh()
    if ($newServer.HasExited) { throw "New server exited. Inspect logs in $logDirectory" }
    try {
        $null = Invoke-RestMethod $clientsUrl -TimeoutSec 1
        Write-Host 'READY: server API is responding. Re-enter the game now.'
        return
    } catch { }
}
throw "Server started but readiness is unconfirmed. Do not rerun blindly. Inspect logs in $logDirectory"
