[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$EnableTasks
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot

$ServerLauncher = Join-Path `
    $PSScriptRoot `
    "launch-server.ps1"

$WorkerLauncher = Join-Path `
    $PSScriptRoot `
    "launch-worker-idempotent.ps1"

$EnvPath = Join-Path `
    $ProjectRoot `
    ".env"

$ServerTaskName =
    "Facebook Multi-Page Publisher Web"

$WorkerTaskName =
    "Facebook Multi-Page Publisher Worker"

$PowerShellPath = Join-Path `
    $env:SystemRoot `
    "System32\WindowsPowerShell\v1.0\powershell.exe"

$UserId = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $ServerLauncher)) {
    throw "Server launcher was not found: $ServerLauncher"
}

if (-not (Test-Path $WorkerLauncher)) {
    throw "Worker launcher was not found: $WorkerLauncher"
}

if (-not (Test-Path $EnvPath)) {
    throw ".env was not found: $EnvPath"
}

$WorkerSetting = Get-Content $EnvPath |
    Where-Object {
        $_ -match "^\s*WORKER_ENABLED\s*="
    }

if ($WorkerSetting -notmatch "^\s*WORKER_ENABLED\s*=\s*true\s*$") {
    throw "WORKER_ENABLED must be true before configuring production startup tasks."
}

$ServerArguments =
    "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ServerLauncher`""

$WorkerArguments =
    "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WorkerLauncher`""

$ServerAction = New-ScheduledTaskAction `
    -Execute $PowerShellPath `
    -Argument $ServerArguments `
    -WorkingDirectory $ProjectRoot

$WorkerAction = New-ScheduledTaskAction `
    -Execute $PowerShellPath `
    -Argument $WorkerArguments `
    -WorkingDirectory $ProjectRoot

$ServerTrigger = New-ScheduledTaskTrigger `
    -AtLogOn `
    -User $UserId

$WorkerTrigger = New-ScheduledTaskTrigger `
    -AtLogOn `
    -User $UserId

$ServerTrigger.Delay = "PT60S"
$WorkerTrigger.Delay = "PT90S"

$Settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$Principal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Limited

Write-Output "PROJECT_PATH=$ProjectRoot"
Write-Output "WINDOWS_USER=$UserId"
Write-Output "SERVER_TASK_NAME=$ServerTaskName"
Write-Output "WORKER_TASK_NAME=$WorkerTaskName"
Write-Output "SERVER_DELAY=PT60S"
Write-Output "WORKER_DELAY=PT90S"
Write-Output "ENABLE_TASKS=$($EnableTasks.IsPresent)"

if ($DryRun) {
    Write-Output "SERVER_EXECUTE=$PowerShellPath"
    Write-Output "SERVER_ARGUMENTS=$ServerArguments"
    Write-Output "WORKER_EXECUTE=$PowerShellPath"
    Write-Output "WORKER_ARGUMENTS=$WorkerArguments"
    Write-Output "MULTIPLE_INSTANCES=IgnoreNew"
    Write-Output "RESTART_COUNT=5"
    Write-Output "START_WHEN_AVAILABLE=True"
    Write-Output "STARTUP_TASK_CONFIGURATION_DRY_RUN=PASSED"

    exit 0
}

Register-ScheduledTask `
    -TaskName $ServerTaskName `
    -Action $ServerAction `
    -Trigger $ServerTrigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Starts the Facebook Multi-Page Publisher production website after Windows logon." `
    -Force |
    Out-Null

Register-ScheduledTask `
    -TaskName $WorkerTaskName `
    -Action $WorkerAction `
    -Trigger $WorkerTrigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Starts the Facebook Multi-Page Publisher continuous worker after Windows logon." `
    -Force |
    Out-Null

if ($EnableTasks) {
    Enable-ScheduledTask `
        -TaskName $ServerTaskName |
        Out-Null

    Enable-ScheduledTask `
        -TaskName $WorkerTaskName |
        Out-Null
}
else {
    Disable-ScheduledTask `
        -TaskName $ServerTaskName |
        Out-Null

    Disable-ScheduledTask `
        -TaskName $WorkerTaskName |
        Out-Null
}

Get-ScheduledTask `
    -TaskName @(
        $ServerTaskName,
        $WorkerTaskName
    ) |
    Select-Object `
        TaskName,
        State,
        Description |
    Format-Table -AutoSize

Write-Output "STARTUP_TASK_CONFIGURATION=COMPLETED"
