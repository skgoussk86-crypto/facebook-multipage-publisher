# start-production.ps1
# Windows PowerShell Startup Script for Facebook Multi-Page Publisher in Production Mode

$Port = 3000
$Address = "127.0.0.1"

Write-Host "Verifying production readiness..." -ForegroundColor Cyan

# 1. Verify port 3000 is available
$PortInUse = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
if ($PortInUse) {
    Write-Host "Error: Port $Port is already in use by process ID $($PortInUse[0].OwningProcess)." -ForegroundColor Red
    Write-Host "Please close the other application or free the port before running this script." -ForegroundColor Yellow
    Exit 1
}

# 2. Verify production build exists
if (-not (Test-Path -Path ".next") -or -not (Test-Path -Path ".next/BUILD_ID")) {
    Write-Host "Error: Production build was not found." -ForegroundColor Red
    Write-Host "Please build the project first by running: npm.cmd run build:prod" -ForegroundColor Yellow
    Exit 1
}

# 3. Print the health check URL and application URLs
Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "  Facebook Multi-Page Publisher - Production Server" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "  Local Health Check: http://$Address:$Port/api/health" -ForegroundColor Yellow
Write-Host "  Application Console: http://$Address:$Port" -ForegroundColor Yellow
Write-Host "========================================================`n" -ForegroundColor Green

# 4. Start production server
npm.cmd run start:prod
