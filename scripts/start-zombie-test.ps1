# Manual recovery of the already-built, standalone zombie experiment.
# Compatible with Windows PowerShell 5.1. Never stops processes or changes policy.
[CmdletBinding()]
param([switch]$CheckOnly)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repositoryPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$nodePath = 'C:\Program Files\nodejs\node.exe'
$entryArgument = 'scripts/h1z1-server-demo-2016.js'
$clientsUrl = 'http://127.0.0.1:13371/api/clients'

function Get-CommandLineArguments([string]$CommandLine) {
    # Parse Windows quoting/backslashes in memory; no helper process or Add-Type.
    $arguments = New-Object 'System.Collections.Generic.List[string]'
    $offset = 0
    while ($offset -lt $CommandLine.Length) {
        while ($offset -lt $CommandLine.Length -and [char]::IsWhiteSpace($CommandLine[$offset])) { $offset++ }
        if ($offset -ge $CommandLine.Length) { break }
        $argument = New-Object System.Text.StringBuilder
        $quoted = $false
        while ($offset -lt $CommandLine.Length) {
            $character = $CommandLine[$offset]
            if (-not $quoted -and [char]::IsWhiteSpace($character)) { break }
            $slashes = 0
            while ($offset -lt $CommandLine.Length -and $CommandLine[$offset] -eq '\') {
                $slashes++
                $offset++
            }
            if ($offset -lt $CommandLine.Length -and $CommandLine[$offset] -eq '"') {
                [void]$argument.Append('\', [int][Math]::Floor($slashes / 2))
                if ($slashes % 2) {
                    [void]$argument.Append('"')
                } elseif ($quoted -and $offset + 1 -lt $CommandLine.Length -and $CommandLine[$offset + 1] -eq '"') {
                    [void]$argument.Append('"')
                    $offset++
                } else {
                    $quoted = -not $quoted
                }
                $offset++
                continue
            }
            [void]$argument.Append('\', $slashes)
            if ($offset -ge $CommandLine.Length) { break }
            $character = $CommandLine[$offset]
            if (-not $quoted -and [char]::IsWhiteSpace($character)) { break }
            [void]$argument.Append($character)
            $offset++
        }
        if ($quoted) { throw 'A Node command line cannot be identified safely. Nothing was started.' }
        $arguments.Add($argument.ToString())
    }
    return $arguments.ToArray()
}

function Get-TestListeners {
    # CIM returns an empty collection, rather than a not-found error, for free ports.
    $udp = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetUDPEndpoint `
        -Filter 'LocalPort = 1115 OR LocalPort = 1117' -OperationTimeoutSec 1)
    $tcp = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection `
        -Filter 'LocalPort = 13371 AND State = 2' -OperationTimeoutSec 1)
    return [pscustomobject]@{ Udp = $udp; Tcp = $tcp }
}

function Assert-StartPreconditions {
    # Whitespace is also nonempty: do not silently turn a supplied DB URL into solo mode.
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable('MONGO_URL', 'Process'))) {
        throw 'MONGO_URL is nonempty. Refusing database-connected startup; no environment value was printed.'
    }
    foreach ($required in @(
        $nodePath,
        (Join-Path $repositoryPath $entryArgument),
        (Join-Path $repositoryPath 'scripts/demo/loginserver2016.js'),
        (Join-Path $repositoryPath 'scripts/demo/ZoneServer2016.js'),
        (Join-Path $repositoryPath 'h1z1-server.js'),
        (Join-Path $repositoryPath 'out/servers/LoginServer/loginserver.js'),
        (Join-Path $repositoryPath 'out/servers/ZoneServer2016/zoneserver.js'),
        (Join-Path $repositoryPath 'config.yaml')
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required existing file is missing: $required. Nothing was built or started."
        }
    }
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -OperationTimeoutSec 2)) {
        if ([string]::IsNullOrEmpty($candidate.CommandLine)) {
            throw "Cannot inspect Node PID $($candidate.ProcessId). Nothing was started."
        }
        $candidateArguments = @(Get-CommandLineArguments $candidate.CommandLine)
        foreach ($argument in @($candidateArguments | Select-Object -Skip 1)) {
            # Match a complete script argument, not a substring in another app's command.
            if (($argument -replace '/', '\') -match '(^|\\)h1z1-server-demo-2016\.js$') {
                throw "Demo server PID $($candidate.ProcessId) already exists. Nothing was stopped or started."
            }
        }
    }
    $listeners = Get-TestListeners
    foreach ($listener in @($listeners.Udp) + @($listeners.Tcp)) {
        throw "Required port $($listener.LocalPort) is occupied by PID $($listener.OwningProcess). Nothing was stopped or started."
    }
}

Assert-StartPreconditions
if ($CheckOnly) {
    Write-Host 'CHECK OK: required files exist; no inherited Mongo URL, demo process, or required-port listener.'
    Write-Host 'Read-only check only: no server started, no environment changed, no log directory created.'
    return
}

# Serialize manual invocations. This is not used by the read-only preflight.
$startMutex = New-Object System.Threading.Mutex($false, 'Local\H1Z1ZombieTestManualStart')
$ownsMutex = $false
$savedEnvironment = @{}
$logDirectory = $null
$newServer = $null
try {
    $ownsMutex = $startMutex.WaitOne(0)
    if (-not $ownsMutex) { throw 'Another manual startup is in progress. Do not rerun blindly.' }
    Assert-StartPreconditions
    $startupEnvironment = @{
        DEBUG = 'LoginServer'
        DEV_HTTP_PORT = '13371'
        DISABLE_NAV = '1'
        TEST_ZOMBIE_NO_AI = 'false'
        WORLD_ID = '2'
        CONFIG_PATH = (Join-Path $repositoryPath 'config.yaml')
    }
    $logDirectory = Join-Path ([IO.Path]::GetTempPath()) ('h1z1-manual-start-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
    # PS5.1 lacks Start-Process -Environment. Change only this process briefly,
    # restore every touched variable in finally, and never persist/print values.
    try {
        foreach ($name in $startupEnvironment.Keys) {
            $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $startupEnvironment[$name], 'Process')
        }
        $newServer = Start-Process -FilePath $nodePath `
            -ArgumentList @('--no-warnings', '--experimental-require-module', $entryArgument) `
            -WorkingDirectory $repositoryPath -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDirectory 'stdout.log') `
            -RedirectStandardError (Join-Path $logDirectory 'stderr.log') -PassThru
    } finally {
        foreach ($name in $savedEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
    }
    Write-Host "New server PID: $($newServer.Id)"
    Write-Host "Logs: $logDirectory"
    $readinessClock = [Diagnostics.Stopwatch]::StartNew()
    while ($readinessClock.Elapsed.TotalSeconds -lt 28) {
        $newServer.Refresh()
        if ($newServer.HasExited) { throw 'The newly started server exited before becoming ready.' }
        $listeners = Get-TestListeners
        foreach ($listener in @($listeners.Udp) + @($listeners.Tcp)) {
            if ($listener.OwningProcess -ne $newServer.Id) {
                throw "Required port $($listener.LocalPort) now belongs to another process."
            }
        }
        $ownsPorts = @($listeners.Udp | Where-Object { $_.LocalPort -eq 1115 }).Count -gt 0 -and `
            @($listeners.Udp | Where-Object { $_.LocalPort -eq 1117 }).Count -gt 0 -and `
            @($listeners.Tcp | Where-Object { $_.LocalAddress -eq '127.0.0.1' }).Count -gt 0
        $apiReady = $false
        if ($ownsPorts -and $readinessClock.Elapsed.TotalSeconds -lt 28) {
            try {
                $reply = Invoke-RestMethod -Uri $clientsUrl -TimeoutSec 1 -UseBasicParsing
                $apiReady = $null -ne $reply -and $null -ne $reply.PSObject.Properties['clients'] -and `
                    $null -ne $reply.clients -and $reply.clients -is [Array]
            } catch { $apiReady = $false }
        }
        if ($apiReady -and $readinessClock.Elapsed.TotalSeconds -lt 29) {
            # Recheck ownership after the response; never accept another API's reply.
            $confirmed = Get-TestListeners
            $allConfirmed = @($confirmed.Udp) + @($confirmed.Tcp)
            $newServer.Refresh()
            if (-not $newServer.HasExited -and $readinessClock.Elapsed.TotalSeconds -lt 30 -and `
                @($allConfirmed | Where-Object { $_.OwningProcess -ne $newServer.Id }).Count -eq 0 -and `
                @($confirmed.Udp | Where-Object { $_.LocalPort -eq 1115 }).Count -gt 0 -and `
                @($confirmed.Udp | Where-Object { $_.LocalPort -eq 1117 }).Count -gt 0 -and `
                @($confirmed.Tcp | Where-Object { $_.LocalAddress -eq '127.0.0.1' }).Count -gt 0) {
                Write-Host 'READY: the started process owns UDP 1115/1117 and the responding local API. Re-enter the game now.'
                return
            }
        }
        if ($readinessClock.Elapsed.TotalSeconds -lt 28) { Start-Sleep -Milliseconds 250 }
    }
    throw 'Readiness was not confirmed within 30 seconds.'
} catch {
    $failure = $_.Exception.Message
    if ($null -ne $newServer) {
        throw "$failure No process was stopped. Do not rerun blindly: inspect PID $($newServer.Id) and logs in $logDirectory."
    }
    if ($null -ne $logDirectory) {
        throw "Startup did not return a confirmed process. Do not rerun blindly; inspect existing processes and logs in $logDirectory."
    }
    throw
} finally {
    if ($ownsMutex) { $startMutex.ReleaseMutex() }
    $startMutex.Dispose()
}
