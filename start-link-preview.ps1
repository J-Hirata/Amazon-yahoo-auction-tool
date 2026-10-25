$ErrorActionPreference = "Stop"
# Compatibility entry point: open the additional page in the existing tool.
& (Join-Path $PSScriptRoot "start-tool.ps1") -Page "/link-monitor.html" -NoPause
