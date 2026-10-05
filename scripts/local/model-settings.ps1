# Shared by the local launchers and installer. This file never reads credentials.
function Set-WatcherModelEnvironment($Config) {
  if (-not $env:WATCHER_OLLAMA_URL -and $Config.ollama.url) { $env:WATCHER_OLLAMA_URL = [string]$Config.ollama.url }
  if (-not $env:WATCHER_OLLAMA_MODEL -and $Config.ollama.model) { $env:WATCHER_OLLAMA_MODEL = [string]$Config.ollama.model }
}

function Save-WatcherModel([string]$ConfigPath, [string]$Url, [string]$Model) {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Install the local watcher first, then configure its model.' }
  $modelConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $nextUrl = if ($Url) { $Url } elseif ($modelConfig.ollama.url) { $modelConfig.ollama.url } else { 'http://localhost:11434' }
  $nextModel = if ($Model) { $Model } elseif ($modelConfig.ollama.model) { $modelConfig.ollama.model } else { 'qwen3:14b' }
  $modelUri = $null
  if (-not [Uri]::TryCreate($nextUrl, [UriKind]::Absolute, [ref]$modelUri) -or
      $modelUri.Scheme -notin @('http', 'https') -or $modelUri.Host -notin @('localhost', '127.0.0.1', '[::1]') -or
      $modelUri.UserInfo -or $modelUri.Query -or $modelUri.Fragment -or $modelUri.AbsolutePath -ne '/') {
    throw 'Use a loopback model origin without credentials, path or query.'
  }
  if ($nextModel -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$') { throw 'The local model name is invalid.' }
  $modelConfig | Add-Member -NotePropertyName ollama -NotePropertyValue @{ url = $modelUri.GetLeftPart([UriPartial]::Authority); model = $nextModel } -Force
  # Keep repo, node and any unrelated fields intact. Replace only after writing valid JSON.
  $tempPath = $ConfigPath + '.model.tmp'
  $modelConfig | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $tempPath -Encoding utf8
  Move-Item -LiteralPath $tempPath -Destination $ConfigPath -Force
}
