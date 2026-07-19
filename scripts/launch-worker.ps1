# launch-worker.ps1
# Background worker launcher for Windows production environment

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Setup logging variables
$LogDir = Join-Path -Path $env:LOCALAPPDATA -ChildPath "FacebookMultiPagePublisher\logs"
if (-not (Test-Path "$LogDir")) {
    New-Item -ItemType Directory -Path "$LogDir" -Force | Out-Null
}
$DateStr = Get-Date -Format "yyyyMMdd"
$LogPath = Join-Path -Path "$LogDir" -ChildPath "worker-launcher-$DateStr.log"

# Start transcript safely to log launcher progress
Start-Transcript -Path "$LogPath" -Append -ErrorAction SilentlyContinue | Out-Null

$ExitCode = 0

try {
    Write-Output "--------------------------------------------------"
    Write-Output "Launcher start: $(Get-Date -Format 'o')"
    Write-Output "Current Windows account: $env:USERNAME"
    Write-Output "DryRun mode: $DryRun"

    # Resolve project root from the script directory.
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not $ScriptDir) {
        $ScriptDir = $PSScriptRoot
    }
    if (-not $ScriptDir) {
        $ScriptDir = Get-Location
    }
    $ProjectRoot = Split-Path -Path $ScriptDir -Parent
    Write-Output "Resolved project path: $ProjectRoot"

    # Set-Location on the project root
    Set-Location -Path "$ProjectRoot"

    # Verify target files exist
    $PackageJsonPath = Join-Path -Path "$ProjectRoot" -ChildPath "package.json"
    $EnvPath = Join-Path -Path "$ProjectRoot" -ChildPath ".env"
    $RunnerScriptPath = Join-Path -Path "$ProjectRoot" -ChildPath "scripts\run-production-worker.ts"

    if (-not (Test-Path "$PackageJsonPath")) {
        throw "CRITICAL ERROR: package.json not found at '$PackageJsonPath'."
    }
    if (-not (Test-Path "$EnvPath")) {
        throw "CRITICAL ERROR: .env file not found at '$EnvPath'."
    }
    if (-not (Test-Path "$RunnerScriptPath")) {
        throw "CRITICAL ERROR: Production worker script not found at '$RunnerScriptPath'."
    }

    # Resolve npm.cmd path
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        throw "CRITICAL ERROR: npm.cmd was not found in PATH."
    }
    $npmPath = $npmCmd.Source
    Write-Output "Resolved npm path: $npmPath"

    # Load environment variables from .env if present silently
    if (Test-Path "$EnvPath") {
        $EnvLines = Get-Content -Path "$EnvPath"
        foreach ($Line in $EnvLines) {
            $TrimmedLine = $Line.Trim()
            if (-not $TrimmedLine -or $TrimmedLine.StartsWith("#")) {
                continue
            }
            if ($TrimmedLine -like "*=*") {
                $Index = $TrimmedLine.IndexOf('=')
                $Key = $TrimmedLine.Substring(0, $Index).Trim()
                $Value = $TrimmedLine.Substring($Index + 1).Trim()

                # Remove one matching pair of outer single or double quotes
                if ($Value.StartsWith('"') -and $Value.EndsWith('"') -and $Value.Length -ge 2) {
                    $Value = $Value.Substring(1, $Value.Length - 2)
                }
                elseif ($Value.StartsWith("'") -and $Value.EndsWith("'") -and $Value.Length -ge 2) {
                    $Value = $Value.Substring(1, $Value.Length - 2)
                }

                [System.Environment]::SetEnvironmentVariable($Key, $Value, [System.EnvironmentVariableTarget]::Process)
            }
        }
    }

    # Safe validation checks (do not leak secrets)
    if (-not $env:DATABASE_URL) {
        throw "Validation Error: DATABASE_URL environment variable is missing."
    }
    if (-not $env:WORKER_ID) {
        throw "Validation Error: WORKER_ID environment variable is missing."
    }

    # Validate WORKER_POLL_INTERVAL_MS
    $PollIntervalStr = $env:WORKER_POLL_INTERVAL_MS
    if (-not $PollIntervalStr) {
        $env:WORKER_POLL_INTERVAL_MS = "10000"
        $PollIntervalStr = "10000"
    }
    $PollIntervalInt = 0
    if (-not [Int32]::TryParse($PollIntervalStr, [ref]$PollIntervalInt) -or $PollIntervalInt -le 0) {
        throw "Validation Error: WORKER_POLL_INTERVAL_MS must be a numeric integer greater than zero. Got '$PollIntervalStr'."
    }

    # Validate WORKER_ERROR_BACKOFF_MS
    $BackoffStr = $env:WORKER_ERROR_BACKOFF_MS
    if (-not $BackoffStr) {
        $env:WORKER_ERROR_BACKOFF_MS = "30000"
        $BackoffStr = "30000"
    }
    $BackoffInt = 0
    if (-not [Int32]::TryParse($BackoffStr, [ref]$BackoffInt) -or $BackoffInt -le 0) {
        throw "Validation Error: WORKER_ERROR_BACKOFF_MS must be a numeric integer greater than zero. Got '$BackoffStr'."
    }

    if ($DryRun) {
        $WorkerEnabledBool = ($env:WORKER_ENABLED -eq "true")
        $WorkerIdPresent = [bool]($env:WORKER_ID)
        $DatabaseUrlPresent = [bool]($env:DATABASE_URL)
        $PollIntervalValid = ($PollIntervalInt -gt 0)
        $BackoffValid = ($BackoffInt -gt 0)
        $ProductionRouteEnabled = ($env:ENABLE_PRODUCTION_WORKER_ROUTE -eq "true")

        Write-Output "PROJECT_PATH=$ProjectRoot"
        Write-Output "NPM_PATH=$npmPath"
        Write-Output "DRY_RUN=True"
        Write-Output "WORKER_ENABLED=$WorkerEnabledBool"
        Write-Output "WORKER_ID_PRESENT=$WorkerIdPresent"
        Write-Output "DATABASE_URL_PRESENT=$DatabaseUrlPresent"
        Write-Output "WORKER_POLL_INTERVAL_VALID=$PollIntervalValid"
        Write-Output "WORKER_ERROR_BACKOFF_VALID=$BackoffValid"
        Write-Output "PRODUCTION_WORKER_ROUTE_ENABLED=$ProductionRouteEnabled"
        Write-Output "WORKER_LAUNCHER_DRY_RUN=PASSED"
        $ExitCode = 0
    }
    else {
        # Normal execution checks
        if ($env:WORKER_ENABLED -ne "true") {
            Write-Output "Safe Refusal: WORKER_ENABLED is not true."
            $ExitCode = 5
        }
        else {
            Write-Output "npm command start: & '$npmPath' run worker"
            try {
                & "$npmPath" run worker
                $ExitCode = $LASTEXITCODE
                Write-Output "npm exit code: $ExitCode"
            }
            catch {
                Write-Output "CRITICAL ERROR: Worker process execution failed: $_"
                $ExitCode = 1
            }
        }
    }
}
catch {
    Write-Output "Launcher failure: $_"
    $ExitCode = 1
}
finally {
    Write-Output "Launcher completion: Exit code $ExitCode"
    Write-Output "--------------------------------------------------"
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}

exit $ExitCode
