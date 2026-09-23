$ErrorActionPreference = "SilentlyContinue"

$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $projectPath "keep-tool-running.ps1"
$logDir = Join-Path $projectPath "logs"
$loopLog = Join-Path $logDir "asin-tool-loop.log"

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-LoopLog($message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $loopLog -Value "[$timestamp] $message"
}

$createdNew = $false
$mutex = New-Object Threading.Mutex($false, "Local\AsinYahooDraftToolWatchLoop", [ref]$createdNew)
if (-not $createdNew) {
  Write-LoopLog "watch loop already running"
  exit 0
}

Write-LoopLog "watch loop started"

try {
  while ($true) {
    try {
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog | Out-Null
    } catch {
      Write-LoopLog "watchdog error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 300
  }
} finally {
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}
