# launch-worker.ps1
# Background worker launcher for Windows production environment

$ErrorActionPreference = "Stop"

# Resolve project root from the script's directory (parent directory of scripts/)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) {
    $ScriptDir = $PSScriptRoot
}
$ProjectRoot = Split-Path -Path $ScriptDir -Parent

# Set-Location on the project root
Set-Location -Path $ProjectRoot

# Fail immediately when package.json is missing
if (-not (Test-Path "package.json")) {
    Write-Error "CRITICAL ERROR: package.json not found in resolved project root '$ProjectRoot'."
    exit 1
}

# Fail immediately when npm.cmd cannot be found
$npmPath = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmPath) {
    Write-Error "CRITICAL ERROR: npm.cmd was not found in PATH."
    exit 1
}

# Load environment variables from .env if present
# Do not print values of variables to the logs
if (Test-Path ".env") {
    Get-Content .env | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $key = $parts[0].Trim()
            $value = $parts[1].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

# Ensure safe defaults if not loaded from environment
if (-not $env:WORKER_POLL_INTERVAL_MS) {
    $env:WORKER_POLL_INTERVAL_MS = "10000"
}
if (-not $env:WORKER_ERROR_BACKOFF_MS) {
    $env:WORKER_ERROR_BACKOFF_MS = "30000"
}

# Invoke npm.cmd run worker
try {
    # Start the worker process
    & npm.cmd run worker
} catch {
    Write-Error "CRITICAL ERROR: Worker process execution encountered a failure."
    exit 1
}

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
