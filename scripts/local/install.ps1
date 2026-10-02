# Sets up the local watcher on this Windows computer: it checks watches routed to this
# PC every 5 minutes and answers Telegram commands (/check, /status, /help). It runs
# alongside the GitHub schedule; each watch is checked by only one of them.
#
#   .\scripts\local\install.ps1 -ServiceAccountPath <key.json> -Owners '{"<uid>":"<chat id>"}'
#     Prompts for the Telegram bot token (or pass -TelegramToken).
#   .\scripts\local\install.ps1 -UpdateToken      Replace only the Telegram token.
#   .\scripts\local\install.ps1 -Calendars '{"<uid>":["<secret iCal address>"]}'
#     Add or replace only the private calendar feeds (Ica's briefing and questions).
#   .\scripts\local\install.ps1 -Uninstall        Remove the task and stored secrets.
#
# Secrets are encrypted with Windows DPAPI, so only this Windows account on this
# computer can read them. The task runs while you are signed in, without a window.
param(
  [string]$ServiceAccountPath,
  [string]$Owners,
  [string]$TelegramToken,
  [switch]$UpdateToken,
  [string]$Calendars,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$taskName = 'Voracity watcher'
$dir = Join-Path $env:USERPROFILE '.voracity-watcher'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  Write-Output 'Removed the scheduled task and stored secrets.'
  return
}

function Save-Secret([string]$name, [Security.SecureString]$value) {
  $value | ConvertFrom-SecureString | Set-Content -Path (Join-Path $dir "$name.secret") -Encoding ascii
}
function Secure([string]$text) { ConvertTo-SecureString $text.Trim() -AsPlainText -Force }
function Ask-Token { Read-Host 'Telegram bot token from @BotFather' -AsSecureString }

New-Item -ItemType Directory -Force $dir | Out-Null
# Only the current user (and SYSTEM) may open the folder.
icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

if ($Calendars -and -not $ServiceAccountPath) {
  # Re-serialise to strict JSON for the same reason as -Owners (see below).
  $calendarMap = $Calendars | ConvertFrom-Json
  Save-Secret 'calendars' (Secure ($calendarMap | ConvertTo-Json -Compress -Depth 4))
  Write-Output 'Calendar feeds saved. Restart the task (or sign out and in) to use them.'
  return
}

if ($UpdateToken) {
  Save-Secret 'telegram-token' $(if ($TelegramToken) { Secure $TelegramToken } else { Ask-Token })
  Write-Output 'Telegram token updated.'
  return
}

if (-not $ServiceAccountPath -or -not (Test-Path $ServiceAccountPath)) { throw 'Pass -ServiceAccountPath with the downloaded service-account JSON key.' }
$key = Get-Content $ServiceAccountPath -Raw
$null = $key | ConvertFrom-Json
if (-not $Owners) { throw 'Pass -Owners, for example ''{"<notes UID>":"<Telegram chat ID>"}'' (copy it from Voracity''s Site watcher setup).' }
# Re-serialise to strict JSON: Windows PowerShell strips embedded double quotes from
# arguments passed to another process, and its parser accepts the unquoted result.
$ownerMap = $Owners | ConvertFrom-Json
$Owners = $ownerMap | ConvertTo-Json -Compress
if ($Owners -notmatch '^\{"[A-Za-z0-9_-]+":') { throw 'Could not read -Owners as {"<notes UID>":"<Telegram chat ID>"}.' }

Save-Secret 'service-account' (Secure $key)
Save-Secret 'owners' (Secure $Owners)
Save-Secret 'telegram-token' $(if ($TelegramToken) { Secure $TelegramToken } else { Ask-Token })

$node = (Get-Command node -ErrorAction Stop).Source
@{ repo = $repo; node = $node } | ConvertTo-Json | Set-Content -Path (Join-Path $dir 'config.json') -Encoding utf8

$run = Join-Path $repo 'scripts\local\run.ps1'
$listen = Join-Path $repo 'scripts\local\listen.ps1'
# One long-running listener (schedule + Telegram commands). conhost --headless hides its window.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$listen`""
# Start at sign-in; the repeating trigger relaunches it within 5 minutes if it ever exits
# (IgnoreNew means it never starts a second copy while one is running).
$trigger = @(
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Checks Voracity site watches routed to this PC every 5 minutes and answers Telegram commands (voracity-watcher).' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Output "Installed. '$taskName' is running and starts whenever you sign in. Message Ica /check to check now."
Write-Output "Secrets are encrypted in $dir. You can now delete the downloaded key file."
Write-Output "Send a test message:  powershell -ExecutionPolicy Bypass -File `"$run`" -Test"
