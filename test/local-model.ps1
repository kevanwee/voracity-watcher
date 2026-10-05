$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/local/model-settings.ps1')
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('ica-model-' + [Guid]::NewGuid().ToString('N'))
$testConfigPath = Join-Path $testDirectory 'config.json'
$previousUrl = $env:WATCHER_OLLAMA_URL
$previousModel = $env:WATCHER_OLLAMA_MODEL
function Assert-ModelTest($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
  New-Item -ItemType Directory -Path $testDirectory | Out-Null
  @{ repo = 'synthetic-repo'; node = 'synthetic-node'; other = 'preserve' } | ConvertTo-Json | Set-Content -LiteralPath $testConfigPath
  Save-WatcherModel $testConfigPath 'http://127.0.0.1:11434' 'synthetic:small'
  $saved = Get-Content -LiteralPath $testConfigPath -Raw | ConvertFrom-Json
  Assert-ModelTest ($saved.repo -eq 'synthetic-repo' -and $saved.node -eq 'synthetic-node' -and $saved.other -eq 'preserve') 'Unrelated fields changed.'
  Assert-ModelTest ($saved.ollama.model -eq 'synthetic:small') 'Model was not saved.'
  $env:WATCHER_OLLAMA_URL = $null; $env:WATCHER_OLLAMA_MODEL = 'explicit:override'
  Set-WatcherModelEnvironment $saved
  Assert-ModelTest ($env:WATCHER_OLLAMA_URL -eq 'http://127.0.0.1:11434' -and $env:WATCHER_OLLAMA_MODEL -eq 'explicit:override') 'Environment precedence failed.'
  Save-WatcherModel $testConfigPath '' 'synthetic:other'
  $saved = Get-Content -LiteralPath $testConfigPath -Raw | ConvertFrom-Json
  Assert-ModelTest ($saved.ollama.url -eq 'http://127.0.0.1:11434') 'Partial update lost endpoint.'
  $original = Get-Content -LiteralPath $testConfigPath -Raw
  foreach ($invalidUrl in @('https://example.com', 'http://user:secret@localhost:11434', 'http://localhost:11434/api')) {
    $rejected = $false
    try { Save-WatcherModel $testConfigPath $invalidUrl 'synthetic' } catch { $rejected = $true }
    Assert-ModelTest $rejected 'Invalid URL was accepted.'
    Assert-ModelTest ((Get-Content -LiteralPath $testConfigPath -Raw) -eq $original) 'Invalid update changed config.'
  }
  Write-Output 'Local model settings: 10 assertions passed using a temporary synthetic config.'
} finally {
  $env:WATCHER_OLLAMA_URL = $previousUrl; $env:WATCHER_OLLAMA_MODEL = $previousModel
  # Only these known test files; no recursive or cross-shell cleanup.
  Remove-Item -LiteralPath $testConfigPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ($testConfigPath + '.model.tmp') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testDirectory -ErrorAction SilentlyContinue
}
