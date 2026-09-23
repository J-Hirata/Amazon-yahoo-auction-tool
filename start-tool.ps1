$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$url = "http://localhost:41731/"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$node = "C:\Program Files\nodejs\node.exe"

$portOpen = $false
try {
  $client = New-Object Net.Sockets.TcpClient
  $async = $client.BeginConnect("127.0.0.1", 41731, $null, $null)
  $portOpen = $async.AsyncWaitHandle.WaitOne(500, $false)
  if ($portOpen) { $client.EndConnect($async) }
  $client.Close()
} catch {
  $portOpen = $false
}

if (-not $portOpen) {
  Write-Host "ASIN Yahoo tool is starting..."
  Start-Process -FilePath $node -ArgumentList "src\server.js" -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 4
} else {
  Write-Host "ASIN Yahoo tool is already running."
}

Write-Host "Opening management page..."
if (Test-Path -LiteralPath $chrome) {
  Start-Process -FilePath $chrome -ArgumentList @("--new-window", $url)
} else {
  Start-Process $url
}

Write-Host ""
Write-Host "Management page: $url"
Write-Host "Press Enter to close this window. The tool keeps running in the background."
Read-Host | Out-Null
