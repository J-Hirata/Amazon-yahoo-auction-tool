param(
  [ValidateSet("/", "/link-monitor.html")]
  [string]$Page = "/",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$cutoverPath = Join-Path $root 'data\cloud-cutover.json'
if (Test-Path -LiteralPath $cutoverPath) {
  $cutover = Get-Content -LiteralPath $cutoverPath -Raw | ConvertFrom-Json
  if ($cutover.version -ne 1 -or $cutover.origin -ne 'https://amazon-yahoo-inventory.vercel.app' -or $cutover.projectId -ne 'prj_GSVAyWDoMTIJepaEbf3YrBplCByT') { throw 'Cloud cutover configuration is invalid. Local editing remains disabled.' }
  $target = $cutover.origin
  if ($Page -eq '/') { $target += '/?view=drafts' }
  Start-Process $target
  Write-Host "Cloud management page: $target"
  return
}
$url = "http://localhost:41731$Page"
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
} else {
  Write-Host "ASIN Yahoo tool is already running."
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    $settings = Invoke-RestMethod -Uri "http://localhost:41731/api/link-monitor" -TimeoutSec 2
    $ready = $settings.config.mode -eq "preview"
    if ($ready) { break }
  } catch { }
  Start-Sleep -Milliseconds 300
}
if (-not $ready) {
  throw "The integrated tool is not ready on port 41731. No browser page was opened."
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
if (-not $NoPause) { Read-Host | Out-Null }
