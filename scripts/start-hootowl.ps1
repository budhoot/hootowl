# Starts the HootOwl API and recovery worker (if they are not already running)
# and opens the dashboard in your web browser. The desktop shortcut runs this file.
#
# Automatic updates: before starting, this downloads the latest HootOwl code from
# GitHub (the "main" branch). If HootOwl is already running and an update exists,
# it asks whether to restart now. Set HOOTOWL_AUTO_UPDATE=false in .env to turn this off.
#
# The API and worker each run in their own minimized window on the taskbar
# ("HootOwl API", "HootOwl Worker"). Close those windows to stop HootOwl.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Add-Type -AssemblyName PresentationFramework

function Show-Message($text, $icon = 'Information', $buttons = 'OK') {
  return [System.Windows.MessageBox]::Show($text, 'HootOwl', $buttons, $icon)
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

# Runs git quietly. Returns its output, or $null if it failed.
function Invoke-Git {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @args 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($output | Out-String).Trim()
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $previous
  }
}

# Checks GitHub for a newer version. Returns 'none', 'available' or 'skip'.
function Test-UpdateAvailable {
  if ((Get-EnvValue 'HOOTOWL_AUTO_UPDATE' 'true') -eq 'false') { return 'skip' }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return 'skip' }
  if (-not (Test-Path (Join-Path $root '.git'))) { return 'skip' }
  if ((Invoke-Git rev-parse --abbrev-ref HEAD) -ne 'main') { return 'skip' }
  # No internet or GitHub unreachable: quietly carry on with the current version.
  if ($null -eq (Invoke-Git fetch --quiet origin main)) { return 'skip' }
  $behind = Invoke-Git rev-list --count HEAD..origin/main
  if ($behind -and [int]$behind -gt 0) { return 'available' }
  return 'none'
}

# Downloads the update. Returns $true if the code changed.
function Install-Update {
  $changedByYou = Invoke-Git status --porcelain --untracked-files=no
  if ($changedByYou) {
    Show-Message ("A HootOwl update is available, but some HootOwl files were changed on this computer, " +
      "so the update was skipped to protect your changes.`n`nChanged files:`n$changedByYou") 'Warning' | Out-Null
    return $false
  }
  $before = Invoke-Git rev-parse HEAD
  if ($null -eq (Invoke-Git merge --ff-only --quiet origin/main)) {
    Show-Message 'The HootOwl update could not be installed. HootOwl will start with the version you have.' 'Warning' | Out-Null
    return $false
  }
  $changedFiles = Invoke-Git diff --name-only $before HEAD
  if ($changedFiles -match 'package(-lock)?\.json') {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'title HootOwl update && npm install' `
      -WorkingDirectory $root -Wait
  }
  return $true
}

# Stops the API, worker and ngrok windows started by this script.
function Stop-HootOwl {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/](server|worker)\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe' OR Name = 'ngrok.exe'" |
    Where-Object { $_.CommandLine -match 'title HootOwl|http --url=' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

if (-not (Test-Path (Join-Path $root '.env'))) {
  Show-Message "HootOwl is not set up yet.`n`nOpen PowerShell in the hootowl folder and run:  npm run setup" 'Warning' | Out-Null
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Show-Message 'Node.js is not installed (or not on the PATH). Install it from https://nodejs.org and try again.' 'Error' | Out-Null
  exit 1
}

$port = Get-EnvValue 'PORT' '3000'
$health = Get-Health $port

if ((Test-UpdateAvailable) -eq 'available') {
  if (-not $health) {
    Install-Update | Out-Null
  } else {
    $answer = Show-Message ("A new version of HootOwl is available.`n`nRestart HootOwl now to install it?`n`n" +
      "It takes about 30 seconds. During that time calls to your clients' Twilio numbers won't connect, " +
      "so choose No if now is a busy time. You'll be asked again next time you open the dashboard.") `
      'Question' 'YesNo'
    if ($answer -eq 'Yes') {
      Stop-HootOwl
      Install-Update | Out-Null
      $health = $null
    }
  }
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm install' -WorkingDirectory $root -Wait
}

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
    Show-Message "The HootOwl API did not start.`n`nClick the 'HootOwl API' window on the taskbar to see the error." 'Error' | Out-Null
    exit 1
  }
}

if (-not $health.worker_online) {
  Start-Window 'HootOwl Worker' 'npm run worker'
}

Start-Process "http://localhost:$port/dashboard/"
