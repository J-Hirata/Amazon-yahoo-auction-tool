$ErrorActionPreference = "SilentlyContinue"

$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $projectPath "logs"
$heartbeatLog = Join-Path $logDir "asin-tool-watchdog.log"
$starter = Join-Path $projectPath "start-tool-background.cmd"

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-WatchdogLog($message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $heartbeatLog -Value "[$timestamp] $message"
}

function Test-AsinToolRunning {
  try {
    $client = New-Object Net.Sockets.TcpClient
    $connect = $client.BeginConnect("127.0.0.1", 41731, $null, $null)
    $connected = $connect.AsyncWaitHandle.WaitOne(800, $false)
    if ($connected) {
      $client.EndConnect($connect)
    }
    $client.Close()
    return $connected
  } catch {
    return $false
  }
}

if (Test-AsinToolRunning) {
  Write-WatchdogLog "already running"
  exit 0
}

Write-WatchdogLog "not running, starting"
Start-Process -FilePath $starter -WorkingDirectory $projectPath -WindowStyle Hidden

Start-Sleep -Seconds 3
if (Test-AsinToolRunning) {
  Write-WatchdogLog "started"
} else {
  Write-WatchdogLog "start attempted but not responding"
}

