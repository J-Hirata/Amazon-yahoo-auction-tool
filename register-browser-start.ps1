$ErrorActionPreference = "Stop"

$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$starter = Join-Path $projectPath "start-tool.cmd"
$key = "HKCU:\Software\Classes\asin-yahoo-tool"
$commandKey = Join-Path $key "shell\open\command"

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "(default)" -Value "URL:ASIN Yahoo Draft Tool"
Set-ItemProperty -Path $key -Name "URL Protocol" -Value ""

New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -Path $commandKey -Name "(default)" -Value "cmd.exe /c start `"ASIN Yahoo Draft Tool`" /min `"$starter`""

Write-Host "Registered asin-yahoo-tool://start"
