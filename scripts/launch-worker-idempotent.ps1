[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkerLauncher = Join-Path `
    $PSScriptRoot `
    "launch-worker.ps1"

$LogDirectory = Join-Path `
    $env:LOCALAPPDATA `
    "FacebookMultiPagePublisher\logs"

if (-not (Test-Path $LogDirectory)) {
    New-Item `
        -ItemType Directory `
        -Path $LogDirectory `
        -Force |
        Out-Null
}

$DateText = Get-Date -Format "yyyyMMdd"

$LogPath = Join-Path `
    $LogDirectory `
    "worker-idempotency-$DateText.log"

Start-Transcript `
    -Path $LogPath `
    -Append `
    -ErrorAction SilentlyContinue |
    Out-Null

$ExitCode = 0

try {
    Write-Output "--------------------------------------------------"
    Write-Output "Worker idempotency launcher start: $((Get-Date).ToString('o'))"
    Write-Output "DryRun mode: $DryRun"
    Write-Output "Resolved project path: $ProjectRoot"

    if (-not (Test-Path $WorkerLauncher)) {
        throw "Worker launcher was not found: $WorkerLauncher"
    }

    $ExistingWorkers = @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.Name -eq "node.exe" -and
                [string]$_.CommandLine -match `
                    "run-production-worker\.ts"
            }
    )

    Write-Output "EXISTING_WORKER_COUNT=$($ExistingWorkers.Count)"

    if ($ExistingWorkers.Count -gt 0) {
        $WorkerPids = (
            $ExistingWorkers |
                Select-Object -ExpandProperty ProcessId
        ) -join ","

        Write-Output "EXISTING_WORKER_PIDS=$WorkerPids"
        Write-Output "WORKER_ALREADY_RUNNING=True"
        Write-Output "No duplicate worker will be started."
        Write-Output "WORKER_IDEMPOTENCY_LAUNCHER=PASSED"
    }
    else {
        Write-Output "WORKER_ALREADY_RUNNING=False"

        $Arguments = @(
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            $WorkerLauncher
        )

        if ($DryRun) {
            $Arguments += "-DryRun"
        }

        Write-Output "Starting the underlying worker launcher."

        & powershell.exe @Arguments

        $ExitCode = $LASTEXITCODE

        if ($ExitCode -ne 0) {
            throw "Underlying worker launcher exited with code $ExitCode."
        }

        if ($DryRun) {
            Write-Output "WORKER_IDEMPOTENCY_LAUNCHER_DRY_RUN=PASSED"
        }
    }
}
catch {
    Write-Error $_

    if ($ExitCode -eq 0) {
        $ExitCode = 1
    }
}
finally {
    Write-Output "Worker idempotency launcher completion: Exit code $ExitCode"
    Write-Output "--------------------------------------------------"

    Stop-Transcript `
        -ErrorAction SilentlyContinue |
        Out-Null
}

exit $ExitCode
