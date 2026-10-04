# Starts the HootOwl API and recovery worker (if they are not already running)
# and opens the dashboard in your web browser. The desktop shortcut runs this file.
#
# The API and worker each run in their own minimized window on the taskbar
# ("HootOwl API", "HootOwl Worker"). Close those windows to stop HootOwl.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Add-Type -AssemblyName PresentationFramework

function Show-Message($text, $icon = 'Information') {
  [System.Windows.MessageBox]::Show($text, 'HootOwl', 'OK', $icon) | Out-Null
}

# Reads one setting from the .env file.
function Get-EnvValue($name, $default) {
  $line = Get-Content (Join-Path $root '.env') |
    Where-Object { $_ -match "^\s*$name\s*=" } |
    Select-Object -First 1
  if ($line) {
    $value = ($line -split '=', 2)[1].Trim()
    if ($value) { return $value }
  }
  return $default
}

function Get-Health($port) {
  try {
    return Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 2
  } catch {
    return $null
  }
}

function Start-Window($title, $command) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "title $title && $command" `
    -WorkingDirectory $root -WindowStyle Minimized
}

if (-not (Test-Path (Join-Path $root '.env'))) {
  Show-Message "HootOwl is not set up yet.`n`nOpen PowerShell in the hootowl folder and run:  npm run setup" 'Warning'
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Show-Message 'Node.js is not installed (or not on the PATH). Install it from https://nodejs.org and try again.' 'Error'
  exit 1
}
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm install' -WorkingDirectory $root -Wait
}

$port = Get-EnvValue 'PORT' '3000'
$health = Get-Health $port

if (-not $health) {
  # Optional: a fixed ngrok address so Twilio can reach this computer.
  $ngrokDomain = Get-EnvValue 'NGROK_DOMAIN' ''
  if ($ngrokDomain -and (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Start-Window 'HootOwl ngrok' "ngrok http --url=$ngrokDomain $port"
  }

  Start-Window 'HootOwl API' 'npm start'
  for ($i = 0; $i -lt 30 -and -not $health; $i++) {
    Start-Sleep -Seconds 1
    $health = Get-Health $port
  }
  if (-not $health) {
    Show-Message "The HootOwl API did not start.`n`nClick the 'HootOwl API' window on the taskbar to see the error." 'Error'
    exit 1
  }
}

if (-not $health.worker_online) {
  Start-Window 'HootOwl Worker' 'npm run worker'
}

Start-Process "http://localhost:$port/dashboard/"
