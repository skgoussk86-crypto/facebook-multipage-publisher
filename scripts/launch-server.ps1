[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
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
    "server-launcher-$DateText.log"

Start-Transcript `
    -Path $LogPath `
    -Append `
    -ErrorAction SilentlyContinue |
    Out-Null

$ExitCode = 0

try {
    Write-Output "--------------------------------------------------"
    Write-Output "Server launcher start: $((Get-Date).ToString('o'))"
    Write-Output "DryRun mode: $DryRun"
    Write-Output "Resolved project path: $ProjectRoot"

    Set-Location $ProjectRoot

    $PackageJsonPath =
        Join-Path $ProjectRoot "package.json"

    $BuildIdPath =
        Join-Path $ProjectRoot ".next\BUILD_ID"

    if (-not (Test-Path $PackageJsonPath)) {
        throw "package.json was not found at '$PackageJsonPath'."
    }

    if (-not (Test-Path $BuildIdPath)) {
        throw "Production build was not found. Missing '$BuildIdPath'."
    }

    $NpmCommand =
        Get-Command npm.cmd -ErrorAction Stop

    $NpmPath = $NpmCommand.Source

    Write-Output "Resolved npm path: $NpmPath"
    Write-Output "Production build present: True"

    $Listener = Get-NetTCPConnection `
        -LocalPort 3000 `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($Listener) {
        $ListenerProcess = Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $($Listener.OwningProcess)"

        $CommandLine =
            [string]$ListenerProcess.CommandLine

        $UsesProjectPath =
            $CommandLine.IndexOf(
                $ProjectRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0

        $IsNextProductionServer =
            $CommandLine -match "next.*start"

        Write-Output "PORT_3000_LISTENER_PID=$($Listener.OwningProcess)"
        Write-Output "PORT_3000_PROJECT_SERVER=$($UsesProjectPath -and $IsNextProductionServer)"

        if (-not ($UsesProjectPath -and $IsNextProductionServer)) {
            throw "Port 3000 is occupied by an unexpected process."
        }

        Write-Output "Server is already running correctly."

        if ($DryRun) {
            Write-Output "SERVER_LAUNCHER_DRY_RUN=PASSED"
        }
        else {
            Write-Output "SERVER_ALREADY_RUNNING=True"
        }
    }
    elseif ($DryRun) {
        Write-Output "PORT_3000_AVAILABLE=True"
        Write-Output "SERVER_LAUNCHER_DRY_RUN=PASSED"
    }
    else {
        $env:NODE_ENV = "production"

        Write-Output "Starting production Next.js server..."
        Write-Output "Command: npm.cmd run start"

        & $NpmPath run start

        $ExitCode = $LASTEXITCODE

        if ($ExitCode -ne 0) {
            throw "The production server exited with code $ExitCode."
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
    Write-Output "Server launcher completion: Exit code $ExitCode"
    Write-Output "--------------------------------------------------"

    Stop-Transcript `
        -ErrorAction SilentlyContinue |
        Out-Null
}

exit $ExitCode
