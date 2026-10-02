# Runs the local watcher until stopped: the 5-minute schedule plus Telegram commands
# (/check, /status, /help). Task Scheduler starts it at sign-in and relaunches it if it
# exits (see install.ps1). Secrets are decrypted with Windows DPAPI for this user.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.voracity-watcher'
$config = Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json
$logDir = Join-Path $dir 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'watcher.log'
if ((Test-Path $log) -and (Get-Content $log).Count -gt 2000) { Get-Content $log | Select-Object -Last 1000 | Set-Content -Path $log -Encoding utf8 }

function Read-Secret([string]$name) {
  $secure = (Get-Content (Join-Path $dir "$name.secret") -Raw).Trim() | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$env:TELEGRAM_BOT_TOKEN = Read-Secret 'telegram-token'
$env:FIREBASE_SERVICE_ACCOUNT = Read-Secret 'service-account'
$env:WATCHER_OWNERS = Read-Secret 'owners'
if (Test-Path (Join-Path $dir 'calendars.secret')) { $env:WATCHER_CALENDARS = Read-Secret 'calendars' }

Set-Location $config.repo
Add-Content -Path $log -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') listener starting"
# Windows PowerShell turns native stderr into error records; keep logging instead of stopping.
$ErrorActionPreference = 'Continue'
& $config.node 'src/listen-main.ts' 2>&1 | ForEach-Object {
  Add-Content -Path $log -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $_"
}
Add-Content -Path $log -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') listener exited ($LASTEXITCODE)"
exit $LASTEXITCODE
