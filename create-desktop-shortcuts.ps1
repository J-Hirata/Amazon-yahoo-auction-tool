$ErrorActionPreference = "Stop"
$root = "D:\src\codex\26,0607,ASINコピーヤフオク!出品"
$desktopCandidates = @(
  "$env:USERPROFILE\OneDrive\デスクトップ",
  [Environment]::GetFolderPath("Desktop"),
  "$env:USERPROFILE\Desktop"
) | Where-Object { $_ -and $_.Trim() } | Select-Object -Unique
$desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $desktop) {
  $desktop = $desktopCandidates | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $desktop | Out-Null
}
$startCmd = Join-Path $root "start-tool.cmd"
$stopCmd = Join-Path $root "stop-tool.cmd"
$created = @()
try {
  $shell = New-Object -ComObject WScript.Shell
  $startLnk = Join-Path $desktop "ASINコピー ヤフオク出品 起動.lnk"
  $s = $shell.CreateShortcut($startLnk)
  $s.TargetPath = $startCmd
  $s.WorkingDirectory = $root
  $s.Description = "ASINコピー ヤフオク出品ツールを起動して管理画面を開く"
  $s.Save()
  $created += $startLnk

  $stopLnk = Join-Path $desktop "ASINコピー ヤフオク出品 停止.lnk"
  $t = $shell.CreateShortcut($stopLnk)
  $t.TargetPath = $stopCmd
  $t.WorkingDirectory = $root
  $t.Description = "ASINコピー ヤフオク出品ツールを停止する"
  $t.Save()
  $created += $stopLnk
} catch {
  $startFallback = Join-Path $desktop "ASINコピー ヤフオク出品 起動.cmd"
  $stopFallback = Join-Path $desktop "ASINコピー ヤフオク出品 停止.cmd"
  Set-Content -LiteralPath $startFallback -Value @("@echo off", "call `"$startCmd`"") -Encoding Default
  Set-Content -LiteralPath $stopFallback -Value @("@echo off", "call `"$stopCmd`"") -Encoding Default
  $created += $startFallback
  $created += $stopFallback
}
Write-Host "作成しました:"
$created | ForEach-Object { Write-Host "- $_" }
Write-Host ""
Write-Host "起動後の管理画面: http://localhost:41731/"
Read-Host "Enterキーで閉じます"
