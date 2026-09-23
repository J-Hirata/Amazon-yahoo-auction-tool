$ErrorActionPreference = "Continue"
$root = "D:\src\codex\26,0607,ASINコピーヤフオク!出品"
$desktopCandidates = @(
  "$env:USERPROFILE\OneDrive\デスクトップ",
  [Environment]::GetFolderPath("Desktop"),
  "$env:USERPROFILE\Desktop"
) | Where-Object { $_ -and $_.Trim() } | Select-Object -Unique
$desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $desktop) {
  Write-Host "デスクトップが見つかりませんでした。"
  Read-Host "Enterキーで閉じます" | Out-Null
  exit 1
}
$desktopSrc = Join-Path $desktop "src"
$names = @(
  "ASINツール起動.cmd", "ASINツール停止.cmd",
  "ASINツール起動.lnk", "ASINツール停止.lnk",
  "ASINコピー ヤフオク出品 起動.cmd", "ASINコピー ヤフオク出品 停止.cmd",
  "ASINコピー ヤフオク出品 起動.lnk", "ASINコピー ヤフオク出品 停止.lnk",
  "デスクトップ用ショートカット作成.cmd",
  "ASINコピー ヤフオク出品 ショートカット作成.cmd"
)
foreach ($base in @($desktop, $desktopSrc)) {
  if (Test-Path -LiteralPath $base) {
    foreach ($name in $names) {
      $p = Join-Path $base $name
      if (Test-Path -LiteralPath $p) {
        try {
          Remove-Item -LiteralPath $p -Force -ErrorAction Stop
          Write-Host "削除: $p"
        } catch {
          Write-Host "削除できませんでした: $p"
        }
      }
    }
  }
}
$launcher = Join-Path $desktop "ASINコピー ヤフオク出品 起動.cmd"
Set-Content -LiteralPath $launcher -Encoding Default -Value @(
  "@echo off",
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"D:\src\codex\26,0607,ASINコピーヤフオク!出品\start-tool.ps1`""
)
Write-Host ""
Write-Host "作成しました: $launcher"
Write-Host ""
Write-Host "今後はデスクトップの『ASINコピー ヤフオク出品 起動』だけを使ってください。"
Write-Host "起動するとツールを立ち上げ、Chromeで http://localhost:41731/ を開きます。"
Read-Host "Enterキーで閉じます" | Out-Null
