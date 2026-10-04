# Creates a "HootOwl Dashboard" shortcut with the HootOwl owl icon on your desktop.
#
#   npm run shortcut
#       Shortcut starts HootOwl on this computer (if needed) and opens the dashboard.
#
#   npm run shortcut -- -Url https://api.hootowl.net/dashboard/
#       Shortcut just opens a dashboard that is already running on a server.
#
# If you move the hootowl folder, run this again so the shortcut points to the new place.

param([string]$Url)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'HootOwl Dashboard.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)

if ($Url) {
  $shortcut.TargetPath = Join-Path $env:WINDIR 'explorer.exe'
  $shortcut.Arguments = $Url
} else {
  $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $launcher = Join-Path $root 'scripts\start-hootowl.ps1'
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
  $shortcut.WindowStyle = 7  # start minimized
}

$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = (Join-Path $root 'assets\hootowl.ico') + ',0'
$shortcut.Description = 'Open the HootOwl operator dashboard'
$shortcut.Save()

Write-Host "Created shortcut: $shortcutPath"
Write-Host 'Double-click "HootOwl Dashboard" on your desktop to open the dashboard.'
