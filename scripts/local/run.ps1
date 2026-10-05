# Runs one watcher check on this computer. Task Scheduler calls this every 5 minutes
# (see install.ps1). Secrets are decrypted with Windows DPAPI for the current user;
# the log records the same counts-only lines as GitHub Actions.
param([switch]$Test)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.voracity-watcher'
$config = Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'model-settings.ps1')
Set-WatcherModelEnvironment $config
$logDir = Join-Path $dir 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'watcher.log'

function Read-Secret([string]$name) {
  $secure = (Get-Content (Join-Path $dir "$name.secret") -Raw).Trim() | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$env:TELEGRAM_BOT_TOKEN = Read-Secret 'telegram-token'
$env:FIREBASE_SERVICE_ACCOUNT = Read-Secret 'service-account'
$env:WATCHER_OWNERS = Read-Secret 'owners'
if (Test-Path (Join-Path $dir 'calendars.secret')) { $env:WATCHER_CALENDARS = Read-Secret 'calendars' }
if (Test-Path (Join-Path $dir 'relay.secret')) { $env:WATCHER_RELAY = Read-Secret 'relay' }
$env:WATCHER_TEST = if ($Test) { 'true' } else { 'false' }
# Only watches GitHub handed over (route 'local') are checked here.
$env:WATCHER_RUNNER = 'local'

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Push-Location $config.repo
try {
  # Windows PowerShell turns native stderr into error records; don't let them abort the run.
  $ErrorActionPreference = 'Continue'
  $output = & $config.node 'src/main.ts' 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
  Remove-Item Env:TELEGRAM_BOT_TOKEN, Env:FIREBASE_SERVICE_ACCOUNT, Env:WATCHER_OWNERS -ErrorAction SilentlyContinue
}
Add-Content -Path $log -Encoding utf8 -Value (@($output) | ForEach-Object { "$stamp $_" })
if ($code -ne 0) { Add-Content -Path $log -Encoding utf8 -Value "$stamp exit code $code" }

# Keep the log small.
$lines = Get-Content $log
if ($lines.Count -gt 2000) { $lines | Select-Object -Last 1000 | Set-Content -Path $log -Encoding utf8 }
exit $code
