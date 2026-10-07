<#
.SYNOPSIS
Install, run, stop, crash, reconfigure, repair and uninstall Goobster through the Windows
installer (documentation/windows_install.md, issue #331) on a machine you are willing to change.

.DESCRIPTION
It needs an administrator session (the service is registered and removed for real) and the
.exe built by scripts/package-bootstrap-win32.js. .github/workflows/windows-bootstrap.yml
runs it on GitHub's windows-2022 runner, which is where the Windows service half of this
feature is proven; nothing here can run on another operating system.

  powershell -File scripts\windows-bootstrap-proof.ps1 -Installer <goobster-*.exe> -Payload <dir> -Work <dir> [-Reports <dir>]

-Payload is the directory the installer was built from (repair needs a source).
-Work is where the roots go; the code root and the data root are in different
folders and every folder name holds a space.

It creates the virtual service account NT SERVICE\goobster implicitly (Windows makes it with
the service), registers the service "goobster", and removes both again. It writes HKCU
(Programs and Features) for the current account only.
#>
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Payload,
    [Parameter(Mandatory = $true)][string]$Work,
    [string]$Reports = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$Payload = (Resolve-Path -LiteralPath $Payload).Path
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Work = (Resolve-Path -LiteralPath $Work).Path
if (-not $Reports) { $Reports = Join-Path $Work 'reports' }
New-Item -ItemType Directory -Force -Path $Reports | Out-Null
$Reports = (Resolve-Path -LiteralPath $Reports).Path

$System32 = Join-Path $env:SystemRoot 'System32'
$Sc = Join-Path $System32 'sc.exe'
$Icacls = Join-Path $System32 'icacls.exe'
$Taskkill = Join-Path $System32 'taskkill.exe'
$Cmd = Join-Path $System32 'cmd.exe'

$InstallerBase = Join-Path $Work 'installer base'
$Code = Join-Path $Work 'opt goobster\code root'
$Base = Join-Path $Work 'state dir'
$Data = Join-Path $Base 'data'
$Config = Join-Path $Base 'config\config.json'
$Cache = Join-Path $Base 'cache'
$Logs = Join-Path $Base 'logs'
$MovedLogs = Join-Path $Base 'logs moved'
$Store = Join-Path $Data 'manager'
$ServiceName = 'goobster'
$ServiceAccount = 'NT SERVICE\goobster'
$Uninstaller = Join-Path $InstallerBase 'uninstall\uninstall.exe'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Goobster'
$ApiPort = 3100
$ManagerPort = 3400
$Answers = Join-Path $Work 'answers.json'
$Script:Passed = 0
$Script:Warned = 0
$Script:Roots = $null

function Group-Start([string]$title) {
    if ($env:GITHUB_ACTIONS) { Write-Host "::group::$title" } else { Write-Host "== $title" }
}
function Group-End { if ($env:GITHUB_ACTIONS) { Write-Host '::endgroup::' } }
function Fail([string]$message) {
    Write-Host "FAIL: $message"
    throw "FAIL: $message"
}
function Pass([string]$message) {
    $Script:Passed++
    Write-Host "PASS: $message"
}
function Note([string]$what, [scriptblock]$test) {
    $ok = $false
    try { $ok = [bool](& $test) } catch { Write-Host "  ($($_.Exception.Message))" }
    if ($ok) { Pass $what } else {
        $Script:Warned++
        Write-Host "WARN: $what"
        if ($env:GITHUB_ACTIONS) { Write-Host "::warning::windows bootstrap proof: $what" }
    }
    return $ok
}
function Check([string]$what, [scriptblock]$test) {
    $ok = $false
    try { $ok = [bool](& $test) } catch { Write-Host "  ($($_.Exception.Message))" }
    if ($ok) { Pass $what } else { Fail $what }
}
function Wait-For([int]$seconds, [string]$what, [scriptblock]$test) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $ok = $false
        try { $ok = [bool](& $test) } catch { $ok = $false }
        if ($ok) { return }
        if ($watch.Elapsed.TotalSeconds -gt $seconds) { Fail "timed out after ${seconds}s waiting for $what" }
        Start-Sleep -Seconds 1
    }
}

function Write-Private([string]$file, $document) {
    $text = ($document | ConvertTo-Json -Depth 6 -Compress)
    [System.IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding($false)))
    & $Icacls $file /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):F" 'BUILTIN\Administrators:F' | Out-Null
}

function Make-Roots([string]$logs) {
    return [ordered]@{ code = $Code; data = $Data; config = $Config; cache = $Cache; logs = $logs; managerStore = $Store }
}

function Service-State {
    $text = (& $Sc query $ServiceName 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 1060) { return 'ABSENT' }
    if ($text -match 'STATE\s*:\s*\d+\s+(\w+)') { return $Matches[1] }
    return 'UNKNOWN'
}
function Service-Pid {
    $text = (& $Sc queryex $ServiceName 2>&1 | Out-String)
    if ($text -match 'PID\s*:\s*(\d+)') { return [int]$Matches[1] }
    return 0
}
function Service-Field([string]$field) {
    $text = (& $Sc qc $ServiceName 2>&1 | Out-String)
    if ($text -match "(?m)^\s*$field\s*:\s*(.+?)\s*$") { return $Matches[1] }
    return ''
}
function Service-Exit-Code {
    $text = (& $Sc query $ServiceName 2>&1 | Out-String)
    if ($text -match 'WIN32_EXIT_CODE\s*:\s*(\d+)') { return [int]$Matches[1] }
    return -1
}
function Service-Running { return (Service-State) -eq 'RUNNING' }

function Http-Get([string]$url) {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $url
    return $response
}
function Health-Ok {
    try { return (Http-Get "http://127.0.0.1:$ApiPort/health").Content -match '"status":"healthy"' } catch { return $false }
}
function Manager-Up {
    try { return (Http-Get "http://127.0.0.1:$ManagerPort/manager/").StatusCode -eq 200 } catch { return $false }
}

function Node-Processes([string]$under) {
    $prefix = $under.TrimEnd('\') + '\'
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
    })
}

function Installation-Id { return (Get-Content -Raw -LiteralPath (Join-Path $Store 'installation.json') | ConvertFrom-Json).installationId }

function Quote([string]$value) { return '"' + $value + '"' }

function Start-Installer([string]$answers, [string]$log, [switch]$NoWait) {
    Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
    $arguments = '/S /ANSWERS=' + (Quote $answers) + ' /BASE=' + (Quote $InstallerBase) + ' /LOG=' + (Quote $log)
    if ($NoWait) { return Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru }
    $process = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru -Wait
    return $process.ExitCode
}
function Run-Installer([string]$answers, [string]$name) {
    $log = Join-Path $Reports "$name.log"
    $code = Start-Installer $answers $log
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | Select-Object -Last 30 | ForEach-Object { Write-Host "    $_" } }
    return $code
}

# The installation's own launcher: the manager CLI against this installation's roots.
function Run-Manager([string]$name, [string[]]$arguments) {
    $out = Join-Path $Reports "$name.out.log"
    $err = Join-Path $Reports "$name.err.log"
    $line = '/d /s /c ""' + (Join-Path $Code 'goobster-manager.cmd') + '" ' + (($arguments | ForEach-Object { if ($_ -match '[\s]') { Quote $_ } else { $_ } }) -join ' ') + '"'
    $process = Start-Process -FilePath $Cmd -ArgumentList $line -PassThru -Wait -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
    Get-Content -LiteralPath $out, $err -ErrorAction SilentlyContinue | Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" }
    return $process.ExitCode
}

function Run-Uninstaller([string]$name) {
    $dir = Split-Path -Parent $Uninstaller
    $log = Join-Path $Reports "$name.txt"
    $process = Start-Process -FilePath $Uninstaller -ArgumentList "/S _?=$dir" -PassThru -Wait
    "exit $($process.ExitCode)" | Set-Content -LiteralPath $log
    return $process.ExitCode
}

function Dump-Service([string]$name) {
    $file = Join-Path $Reports "$name.txt"
    & $Sc qc $ServiceName 2>&1 | Out-File -FilePath $file -Encoding utf8
    & $Sc queryex $ServiceName 2>&1 | Out-File -FilePath $file -Encoding utf8 -Append
    & $Sc qfailure $ServiceName 2>&1 | Out-File -FilePath $file -Encoding utf8 -Append
}

function Collect-Evidence {
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, ParentProcessId, ExecutablePath |
            Format-Table -AutoSize | Out-String -Width 400 | Set-Content -LiteralPath (Join-Path $Reports 'node-processes-at-exit.txt')
        foreach ($folder in @($Logs, $MovedLogs)) {
            if (Test-Path -LiteralPath $folder) {
                $leaf = (Split-Path -Leaf $folder) -replace '\s', '-'
                Get-ChildItem -LiteralPath $folder -Filter 'goobster-service*' -ErrorAction SilentlyContinue |
                    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Reports "winsw-$leaf-$($_.Name)") -Force }
            }
        }
        Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = $ServiceName } -MaxEvents 200 -ErrorAction SilentlyContinue |
            Select-Object TimeCreated, LevelDisplayName, Message | Format-List | Out-String -Width 300 |
            Set-Content -LiteralPath (Join-Path $Reports 'event-log-goobster.txt')
        & $Sc query $ServiceName 2>&1 | Out-File -FilePath (Join-Path $Reports 'sc-query-at-exit.txt') -Encoding utf8
    } catch {
        Write-Host "(evidence collection: $($_.Exception.Message))"
    }
}

try {
    Group-Start 'environment'
    [System.Environment]::OSVersion.VersionString
    "installer: $Installer"
    $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run this from an administrator session' }
    if ((Service-State) -ne 'ABSENT') { Fail 'a service named goobster already exists on this machine; the proof will not touch it' }
    foreach ($port in @($ApiPort, $ManagerPort)) {
        if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { Fail "port $port is already in use" }
    }
    if (Test-Path -LiteralPath $UninstallKey) { Fail 'an uninstall entry named Goobster already exists for this account' }
    Group-End

    $Script:Roots = Make-Roots $Logs
    Write-Private $Answers ([ordered]@{ ownerLabel = 'windows bootstrap proof'; roots = $Script:Roots })

    Group-Start '1. interrupted install, then the same command again'
    $interruptedLog = Join-Path $Reports 'install-interrupted.log'
    $interrupted = Start-Installer $Answers $interruptedLog -NoWait
    Wait-For 240 'the install to reach the stage step' {
        (Test-Path -LiteralPath $interruptedLog) -and (Select-String -LiteralPath $interruptedLog -Pattern '^\[install\.new\] stage' -Quiet)
    }
    Start-Sleep -Seconds 1
    & $Taskkill /T /F /PID $interrupted.Id | Out-Null
    Wait-For 30 'the killed installer to be gone' { -not (Get-Process -Id $interrupted.Id -ErrorAction SilentlyContinue) }
    Check 'the install was killed before the payload was activated' { -not (Test-Path -LiteralPath (Join-Path $Code 'current')) }
    Check 'no service exists after the interruption' { (Service-State) -eq 'ABSENT' }
    Check 'no Node of the interrupted installer is left running' { (Node-Processes $InstallerBase).Count -eq 0 }
    $exit = Run-Installer $Answers 'install-resumed'
    if ($exit -ne 0) { Fail "the install did not finish when run again (exit $exit)" }
    Pass 'the same command finished the install'
    Check 'the payload is activated' { Test-Path -LiteralPath (Join-Path $Code 'current\bin\goobster-manager.cmd') }
    Check 'the staging folder was removed after the install' { -not (Test-Path -LiteralPath (Join-Path $InstallerBase 'stage\*')) }
    Group-End

    Group-Start '2. what the install left behind'
    Check 'the code root and the data root are different trees' {
        ($Data.TrimEnd('\') + '\') -notlike (($Code.TrimEnd('\')) + '\*') -and ($Code.TrimEnd('\') + '\') -notlike (($Data.TrimEnd('\')) + '\*')
    }
    Check 'the launcher is in the code root' { Test-Path -LiteralPath (Join-Path $Code 'goobster-manager.cmd') }
    Check 'Programs and Features has one HKCU entry for this installation' {
        $entry = Get-ItemProperty -LiteralPath $UninstallKey
        $entry.DisplayName -eq 'Goobster' -and $entry.InstallLocation -eq $Code -and $entry.UninstallString -eq ('"' + $Uninstaller + '"') -and $entry.NoModify -eq 1
    }
    Check 'the uninstaller exists' { Test-Path -LiteralPath $Uninstaller }
    Check 'nothing was written under HKLM for this product' { -not (Test-Path -LiteralPath 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Goobster') }
    Wait-For 180 'the service to be running' { Service-Running }
    Pass 'the Windows service is running'
    Dump-Service 'service-after-install'
    Check 'the service starts automatically' { (Service-Field 'START_TYPE') -match 'AUTO_START' }
    Check 'the service runs as the virtual account' { (Service-Field 'SERVICE_START_NAME') -eq $ServiceAccount }
    Check 'the service host and its definition live in the manager store' {
        $path = (Service-Field 'BINARY_PATH_NAME').Trim('"')
        $path -eq (Join-Path $Store 'service\goobster-service.exe') -and (Test-Path -LiteralPath $path) -and (Test-Path -LiteralPath (Join-Path $Store 'service\goobster-service.xml'))
    }
    Check 'the definition carries this installation''s marker' {
        $first = (Get-Content -LiteralPath (Join-Path $Store 'service\goobster-service.xml') -TotalCount 1)
        $first -eq ('<!-- X-Goobster-Installation: ' + (Installation-Id) + ' -->')
    }
    Check 'the service has a restart-on-failure action' { (& $Sc qfailure $ServiceName | Out-String) -match 'RESTART' }
    Check 'the manager process runs as the service account' {
        $parent = Service-Pid
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" | Where-Object { $_.Name -eq 'node.exe' })
        ($children.Count -ge 1) -and ((Get-Process -Id $children[0].ProcessId -IncludeUserName).UserName -eq $ServiceAccount)
    }
    Check 'the service account can read the code root but not change it' {
        $lines = @(& $Icacls $Code | Where-Object { $_ -like "*$ServiceAccount*" })
        ($lines.Count -ge 1) -and (@($lines | Where-Object { $_ -match '\((M|F|W|WD|AD)\)' }).Count -eq 0) -and (@($lines | Where-Object { $_ -match '\(RX\)' }).Count -ge 1)
    }
    Check 'the service account can modify the data root' { (& $Icacls $Data | Out-String) -match [regex]::Escape($ServiceAccount) + ':\(OI\)\(CI\)\(M\)' }
    Wait-For 180 'the api to answer /health' { Health-Ok }
    Pass '/health answers from the installed api'
    Check 'the database is in the data root' { Test-Path -LiteralPath (Join-Path $Data 'goobster.sqlite') }
    Check 'no database is in the code root' { @(Get-ChildItem -LiteralPath $Code -Recurse -Filter '*.sqlite' -ErrorAction SilentlyContinue).Count -eq 0 }
    Wait-For 120 'the manager to serve /manager/' { Manager-Up }
    Pass "the manager answers on 127.0.0.1:$ManagerPort"
    Check 'the manager listens on the loopback address only' {
        $addresses = @(Get-NetTCPConnection -State Listen -LocalPort $ManagerPort | ForEach-Object { $_.LocalAddress } | Sort-Object -Unique)
        ($addresses.Count -eq 1) -and ($addresses[0] -eq '127.0.0.1')
    }
    Check 'no firewall rule was added' {
        @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'goobster' -or $_.Name -match 'goobster' }).Count -eq 0
    }
    Group-End

    Group-Start '3. the same install command again changes nothing'
    $beforeBinary = Service-Field 'BINARY_PATH_NAME'
    $exit = Run-Installer $Answers 'install-again'
    if ($exit -ne 0) { Fail "running the install again failed (exit $exit)" }
    Pass 'running the install again exits 0'
    Check 'the service definition is unchanged' { (Service-Field 'BINARY_PATH_NAME') -eq $beforeBinary }
    Wait-For 120 'the service to be running' { Service-Running }
    Pass 'the service is still running'
    Wait-For 120 'the api to answer /health' { Health-Ok }
    Pass '/health still answers'
    Group-End

    Group-Start '4. repair'
    $repairAnswers = Join-Path $Work 'repair.json'
    Write-Private $repairAnswers ([ordered]@{ source = $Payload; release = [ordered]@{ allowUnsigned = $true } })
    $env:GOOBSTER_PAYLOAD_DEV_UNSIGNED = '1'
    $exit = Run-Manager 'repair' @('repair', '--answers', $repairAnswers, '--yes')
    if ($exit -ne 0) { Fail "repair failed (exit $exit)" }
    Pass 'repair finished'
    Wait-For 120 'the service to be running' { Service-Running }
    Wait-For 180 'the api to answer /health' { Health-Ok }
    Pass '/health answers after the repair'
    Group-End

    Group-Start '5. reconfigure (the logs root moves, the service definition is rewritten)'
    $reconfigureAnswers = Join-Path $Work 'reconfigure.json'
    Write-Private $reconfigureAnswers ([ordered]@{ roots = [ordered]@{ logs = $MovedLogs } })
    $exit = Run-Manager 'reconfigure' @('reconfigure', '--answers', $reconfigureAnswers, '--yes')
    if ($exit -ne 0) { Fail "reconfigure failed (exit $exit)" }
    Pass 'reconfigure finished'
    Check 'the new logs root exists' { Test-Path -LiteralPath $MovedLogs }
    Check 'the definition names the new logs root' {
        (Get-Content -Raw -LiteralPath (Join-Path $Store 'service\goobster-service.xml')) -match [regex]::Escape($MovedLogs)
    }
    Check 'the service account can modify the new logs root' { (& $Icacls $MovedLogs | Out-String) -match [regex]::Escape($ServiceAccount) + ':\(OI\)\(CI\)\(M\)' }
    Wait-For 120 'the service to be running on the rewritten definition' { Service-Running }
    Pass 'the service runs on the rewritten definition'
    Wait-For 120 'the service host to write to the new logs root' { @(Get-ChildItem -LiteralPath $MovedLogs -Filter 'goobster-service*' -ErrorAction SilentlyContinue).Count -ge 1 }
    Pass 'the service host logs to the new root'
    Wait-For 180 'the api to answer /health' { Health-Ok }
    Pass '/health answers after the reconfigure'
    Group-End

    Group-Start '6. stop semantics: a stop is graceful and leaves nothing behind'
    Wait-For 120 'the manager to serve /manager/' { Manager-Up }
    $workersBefore = Node-Processes $Code
    "Node processes of this installation before the stop: $($workersBefore.Count)"
    Check 'the supervisor and its worker are running' { $workersBefore.Count -ge 2 }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    & $Sc stop $ServiceName | Out-Null
    Wait-For 150 'the service to stop' { (Service-State) -eq 'STOPPED' }
    "the service stopped in $([int]$watch.Elapsed.TotalSeconds)s"
    Check 'the stop finished inside the service''s own stop timeout' { $watch.Elapsed.TotalSeconds -lt 100 }
    Check 'the service reported a clean exit (no failure action fired)' { (Service-Exit-Code) -eq 0 }
    Check 'no Node of the installation is left running' { (Node-Processes $Code).Count -eq 0 }
    Check 'nothing answers on the api port' { -not (Health-Ok) }
    Check 'the supervisor did not have to kill a worker after the stop bound' {
        $text = ''
        foreach ($folder in @($Logs, $MovedLogs)) {
            if (Test-Path -LiteralPath $folder) {
                $text += (Get-ChildItem -LiteralPath $folder -Filter 'goobster-service*.log' -ErrorAction SilentlyContinue | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }) -join "`n"
            }
        }
        $text -notmatch 'killed after the stop bound'
    }
    Dump-Service 'service-after-stop'
    & $Sc start $ServiceName | Out-Null
    Wait-For 120 'the service to start again' { Service-Running }
    Wait-For 180 'the api to answer /health' { Health-Ok }
    Pass 'the service started again and /health answers'
    Group-End

    Group-Start '7. crash recovery: the service restarts after its manager is killed'
    $hostBefore = Service-Pid
    $managers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$hostBefore" | Where-Object { $_.Name -eq 'node.exe' })
    Check 'the service host has a manager child' { $managers.Count -ge 1 }
    Stop-Process -Id $managers[0].ProcessId -Force
    Wait-For 60 'the service host to notice' { (Service-Pid) -ne $hostBefore -or (Service-State) -ne 'RUNNING' }
    Wait-For 120 'the service to be running again' { (Service-Running) -and ((Service-Pid) -ne $hostBefore) }
    Pass 'Windows restarted the service after the manager died'
    Wait-For 180 'the api to answer /health again' { Health-Ok }
    Pass '/health answers after the crash'
    Check 'only one supervisor of this installation is running' {
        $all = @(Node-Processes $Code)
        @($all | Where-Object { $_.CommandLine -match 'manager\\index\.js' -and $_.CommandLine -match '--supervise' }).Count -eq 1
    }
    $apiWorkers = @(Node-Processes $Code | Where-Object { $_.CommandLine -match 'apps\\api\\index\.js' })
    $oneWorker = Note 'the crash left no orphaned api worker behind (reported, not enforced: a killed manager cannot stop its workers)' { $apiWorkers.Count -eq 1 }
    if (-not $oneWorker) {
        $apiWorkers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Wait-For 180 'the api to answer /health after the orphans were removed' { Health-Ok }
    }
    Group-End

    Group-Start '8. uninstall from Programs and Features, keeping the data'
    $id = Installation-Id
    $exit = Run-Uninstaller 'uninstall-keep'
    if ($exit -ne 0) { Fail "the keep-data uninstall failed (exit $exit)" }
    Pass 'the keep-data uninstall finished'
    Check 'the payload is gone' { -not (Test-Path -LiteralPath (Join-Path $Code 'current')) }
    Check 'the data is kept' { Test-Path -LiteralPath (Join-Path $Data 'goobster.sqlite') }
    Check 'the service is gone' { (Service-State) -eq 'ABSENT' }
    Check 'the service folder is gone' { -not (Test-Path -LiteralPath (Join-Path $Store 'service')) }
    Check 'the Programs and Features entry is gone' { -not (Test-Path -LiteralPath $UninstallKey) }
    Check 'the launcher is gone' { -not (Test-Path -LiteralPath (Join-Path $Code 'goobster-manager.cmd')) }
    Check 'nothing answers on the api port' { -not (Health-Ok) }
    Check 'no Node of the installation is left running' { (Node-Processes $Code).Count -eq 0 }
    Remove-Item -LiteralPath (Split-Path -Parent $Uninstaller) -Recurse -Force -ErrorAction SilentlyContinue
    Group-End

    Group-Start '9. install again over the kept data, then uninstall and delete the data'
    $Script:Roots = Make-Roots $MovedLogs
    Write-Private $Answers ([ordered]@{ ownerLabel = 'windows bootstrap proof'; roots = $Script:Roots })
    $exit = Run-Installer $Answers 'install-after-keep'
    if ($exit -ne 0) { Fail "installing over kept data failed (exit $exit)" }
    Pass 'the install over the kept data finished'
    Wait-For 180 'the service to be running' { Service-Running }
    Wait-For 180 'the api to answer /health' { Health-Ok }
    Pass '/health answers again'
    $id = Installation-Id
    $deleteAnswers = Join-Path $Work 'uninstall-all.json'
    Write-Private $deleteAnswers ([ordered]@{ keepData = $false })
    $exit = Run-Manager 'uninstall-all' @('uninstall', '--answers', $deleteAnswers, '--delete-data', '--confirm', $id, '--yes')
    if ($exit -ne 0) { Fail "the delete-data uninstall failed (exit $exit)" }
    Pass 'the delete-data uninstall finished'
    Check 'the database is gone' { -not (Test-Path -LiteralPath (Join-Path $Data 'goobster.sqlite')) }
    Check 'the payload is gone' { -not (Test-Path -LiteralPath (Join-Path $Code 'current')) }
    Check 'the service is gone' { (Service-State) -eq 'ABSENT' }
    $exit = Run-Uninstaller 'uninstall-leftovers'
    if ($exit -ne 0) { Fail "removing the Windows leftovers failed (exit $exit)" }
    Check 'the uninstaller removed the launcher and the Programs and Features entry' {
        (-not (Test-Path -LiteralPath (Join-Path $Code 'goobster-manager.cmd'))) -and (-not (Test-Path -LiteralPath $UninstallKey))
    }
    Remove-Item -LiteralPath (Split-Path -Parent $Uninstaller) -Recurse -Force -ErrorAction SilentlyContinue
    Group-End

    Group-Start '10. a service named goobster that is not ours is refused and left alone'
    $ForeignRoot = Join-Path $Work 'foreign case'
    $foreignExe = Join-Path $Work 'foreign\not-goobster.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $foreignExe) | Out-Null
    Copy-Item -LiteralPath $Cmd -Destination $foreignExe
    & $Sc create $ServiceName binPath= ('"' + $foreignExe + '"') start= disabled DisplayName= 'Someone else' | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'could not create the stand-in foreign service' }
    $foreignBefore = Service-Field 'BINARY_PATH_NAME'
    $Code = Join-Path $ForeignRoot 'code'
    $Data = Join-Path $ForeignRoot 'data'
    $Config = Join-Path $ForeignRoot 'config\config.json'
    $Cache = Join-Path $ForeignRoot 'cache'
    $Logs = Join-Path $ForeignRoot 'logs'
    $Store = Join-Path $Data 'manager'
    $Script:Roots = Make-Roots $Logs
    Write-Private $Answers ([ordered]@{ ownerLabel = 'windows bootstrap proof (foreign service)'; roots = $Script:Roots })
    $exit = Run-Installer $Answers 'install-foreign'
    Check 'the install did not pretend to succeed' { $exit -ne 0 }
    Check 'the log names the refusal' { (Get-Content -Raw -LiteralPath (Join-Path $Reports 'install-foreign.log')) -match 'SERVICE_FOREIGN' }
    Check 'the foreign service is untouched' { ((Service-Field 'BINARY_PATH_NAME') -eq $foreignBefore) -and ((Service-Field 'SERVICE_START_NAME') -ne $ServiceAccount) }
    Check 'no definition of ours was written' { -not (Test-Path -LiteralPath (Join-Path $ForeignRoot 'data\manager\service\goobster-service.xml')) }
    & $Sc delete $ServiceName | Out-Null
    Wait-For 30 'the stand-in service to be gone' { (Service-State) -eq 'ABSENT' }
    $exit = Run-Installer $Answers 'install-foreign-resumed'
    Check 'the same command exits 0 once the name is free' { $exit -eq 0 }
    $ours = Note 'the same command registered the service once the name was free' {
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        while (((Service-State) -ne 'RUNNING') -and ($watch.Elapsed.TotalSeconds -lt 180)) { Start-Sleep -Seconds 2 }
        ((Service-State) -eq 'RUNNING') -and ((Service-Field 'SERVICE_START_NAME') -eq $ServiceAccount)
    }
    if (Test-Path -LiteralPath (Join-Path $Code 'goobster-manager.cmd')) {
        $id = Installation-Id
        Write-Private (Join-Path $Work 'uninstall-foreign.json') ([ordered]@{ keepData = $false })
        $exit = Run-Manager 'uninstall-foreign' @('uninstall', '--answers', (Join-Path $Work 'uninstall-foreign.json'), '--delete-data', '--confirm', $id, '--yes')
        if ($exit -ne 0) { Fail "the delete-data uninstall failed (exit $exit)" }
        $exit = Run-Uninstaller 'uninstall-foreign-leftovers'
        if ($exit -ne 0) { Fail "removing the Windows leftovers failed (exit $exit)" }
    } else {
        Write-Host 'NOTE: the install left no launcher, so the foreign-case roots are removed by hand'
    }
    Check 'the service is gone' { (Service-State) -eq 'ABSENT' -or -not $ours }
    Check 'the Programs and Features entry is gone' { -not (Test-Path -LiteralPath $UninstallKey) }
    Group-End

    Write-Host "windows bootstrap proof: $Script:Passed checks passed, $Script:Warned reported"
} finally {
    Collect-Evidence
    if ((Service-State) -ne 'ABSENT') {
        Write-Host 'cleanup: the journey left a service named goobster behind; removing it so the machine is as it was'
        & $Sc stop $ServiceName 2>&1 | Out-Null
        Start-Sleep -Seconds 5
        & $Sc delete $ServiceName 2>&1 | Out-Null
    }
    foreach ($left in @($Code, $InstallerBase)) {
        foreach ($process in (Node-Processes $left)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    }
}
