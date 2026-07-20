[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Version = "latest",
  [ValidateSet("gtrace", "otlp", "otel")]
  [string]$Type,
  [string]$Endpoint,
  [string]$XToken,
  [string[]]$Tag = @(),
  [string]$OssEndpoint = $env:OSS_ENDPOINT,
  [string]$PluginDir = $env:OPENCLAW_PLUGIN_DIR,
  [string]$ConfigFile = $env:OPENCLAW_CONFIG_FILE,
  [string]$PluginName = "openclaw-otel-plugin",
  [switch]$NoConfig,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

function Write-InstallLog([string]$Message) {
  Write-Host "[install] $Message"
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "[install] missing command: $Name"
  }
}

function Get-PropertyValue($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Ensure-ObjectProperty($Object, [string]$Name) {
  $value = Get-PropertyValue $Object $Name
  if ($null -eq $value) {
    $value = [pscustomobject]@{}
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $value -Force
  }
  return $value
}

function Set-ObjectProperty($Object, [string]$Name, $Value) {
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Resolve-DownloadBaseUrl {
  if ([string]::IsNullOrWhiteSpace($OssEndpoint)) {
    throw "[install] OSS_ENDPOINT or -OssEndpoint is required for an OSS-backed install"
  }
  $root = $OssEndpoint.TrimEnd("/")
  if ($root.EndsWith("/$PluginName")) { return $root }
  return "$root/$PluginName"
}

function Download-Archive([string]$Url, [string]$Target) {
  Write-InstallLog "downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
  try {
    $checksumPath = "$Target.sha256"
    Invoke-WebRequest -Uri "$Url.sha256" -OutFile $checksumPath -UseBasicParsing
    $expected = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $expected -or $expected -ne $actual) {
      throw "[install] sha256 verification failed: $Url"
    }
    Write-InstallLog "sha256 verified"
  } catch {
    if ($_.Exception.Message -like "[install] sha256 verification failed*") { throw }
    Write-InstallLog "checksum not found, skipped sha256 verification"
  }
}

if ([string]::IsNullOrWhiteSpace($PluginDir)) {
  $PluginDir = Join-Path $HOME ".openclaw\extensions\openclaw-otel-plugin"
}
if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
  $ConfigFile = Join-Path $HOME ".openclaw\openclaw.json"
}

Require-Command "node"
Require-Command "tar"
$npmCommand = "npm"
if ($env:OS -eq "Windows_NT") { $npmCommand = "npm.cmd" }
Require-Command $npmCommand

$existingConfig = $null
if (Test-Path -LiteralPath $ConfigFile) {
  $rawConfig = Get-Content -LiteralPath $ConfigFile -Raw
  if (-not [string]::IsNullOrWhiteSpace($rawConfig)) {
    $existingConfig = $rawConfig | ConvertFrom-Json
    $existingEntry = Get-PropertyValue (Get-PropertyValue (Get-PropertyValue $existingConfig "plugins") "entries") $PluginName
    $existingPluginConfig = Get-PropertyValue $existingEntry "config"
    if ([string]::IsNullOrWhiteSpace($Endpoint)) {
      $Endpoint = Get-PropertyValue $existingPluginConfig "endpoint"
      if ($Endpoint) { Write-InstallLog "reusing existing endpoint from $ConfigFile" }
    }
    if ([string]::IsNullOrWhiteSpace($XToken)) {
      $XToken = Get-PropertyValue (Get-PropertyValue $existingPluginConfig "headers") "X-Token"
      if ($XToken) { Write-InstallLog "reusing existing X-Token from $ConfigFile" }
    }
  }
}

if ($Type -eq "otel") { $Type = "otlp" }
if ([string]::IsNullOrWhiteSpace($Type)) { $Type = "gtrace" }
if (-not $NoConfig -and $Type -eq "gtrace") {
  if ([string]::IsNullOrWhiteSpace($Endpoint)) { throw "[install] type=gtrace requires -Endpoint" }
  if ([string]::IsNullOrWhiteSpace($XToken)) { throw "[install] type=gtrace requires -XToken" }
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-otel-plugin-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  $archivePath = Join-Path $tempDir "plugin.tar.gz"
  if ($Version -match "^https?://") {
    Download-Archive $Version $archivePath
  } elseif ($Version.EndsWith(".tar.gz") -and (Test-Path -LiteralPath $Version)) {
    Write-InstallLog "using local archive $Version"
    Copy-Item -LiteralPath $Version -Destination $archivePath
  } else {
    $downloadBase = Resolve-DownloadBaseUrl
    if ([string]::IsNullOrWhiteSpace($Version) -or $Version -eq "latest") {
      Download-Archive "$downloadBase/$PluginName.tar.gz" $archivePath
    } else {
      $normalizedVersion = $Version.TrimStart("v")
      Download-Archive "$downloadBase/$PluginName-v$normalizedVersion.tar.gz" $archivePath
    }
  }

  & tar -xzf $archivePath -C $tempDir
  if ($LASTEXITCODE -ne 0) { throw "[install] archive extraction failed" }
  $payloadDir = Get-ChildItem -LiteralPath $tempDir -Directory | Select-Object -First 1
  if ($null -eq $payloadDir -or
      -not (Test-Path -LiteralPath (Join-Path $payloadDir.FullName "openclaw.plugin.json")) -or
      -not (Test-Path -LiteralPath (Join-Path $payloadDir.FullName "dist\index.cjs"))) {
    throw "[install] incomplete plugin archive contents"
  }

  $pluginParent = Split-Path -Parent $PluginDir
  New-Item -ItemType Directory -Path $pluginParent -Force | Out-Null
  if (Test-Path -LiteralPath $PluginDir) { Remove-Item -LiteralPath $PluginDir -Recurse -Force }
  Copy-Item -LiteralPath $payloadDir.FullName -Destination $PluginDir -Recurse
  Write-InstallLog "installed to $PluginDir"

  $npmRoot = (& $npmCommand root -g).Trim()
  $openclawRuntime = Join-Path $npmRoot "openclaw"
  if ([string]::IsNullOrWhiteSpace($npmRoot) -or -not (Test-Path -LiteralPath $openclawRuntime)) {
    throw "[install] global openclaw package directory was not found. Make sure OpenClaw CLI is installed correctly"
  }
  $nodeModules = Join-Path $PluginDir "node_modules"
  $runtimeLink = Join-Path $nodeModules "openclaw"
  New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
  if (Test-Path -LiteralPath $runtimeLink) { Remove-Item -LiteralPath $runtimeLink -Recurse -Force }
  New-Item -ItemType Junction -Path $runtimeLink -Target $openclawRuntime | Out-Null
  Write-InstallLog "linked host openclaw runtime from $openclawRuntime"

  if (-not $NoConfig) {
    $config = $existingConfig
    if ($null -eq $config) { $config = [pscustomobject]@{} }
    $plugins = Ensure-ObjectProperty $config "plugins"
    $allow = @(Get-PropertyValue $plugins "allow")
    if ($allow -notcontains $PluginName) { $allow += $PluginName }
    Set-ObjectProperty $plugins "allow" $allow
    $load = Ensure-ObjectProperty $plugins "load"
    $paths = @(Get-PropertyValue $load "paths")
    if ($paths -notcontains $PluginDir) { $paths += $PluginDir }
    Set-ObjectProperty $load "paths" $paths
    $entries = Ensure-ObjectProperty $plugins "entries"
    $entry = Get-PropertyValue $entries $PluginName
    if ($null -eq $entry) { $entry = [pscustomobject]@{}; Set-ObjectProperty $entries $PluginName $entry }
    Set-ObjectProperty $entry "enabled" $true
    $pluginConfig = Ensure-ObjectProperty $entry "config"
    if ($null -eq (Get-PropertyValue $pluginConfig "enabled")) { Set-ObjectProperty $pluginConfig "enabled" $true }
    if ($Endpoint) { Set-ObjectProperty $pluginConfig "endpoint" $Endpoint }
    $resources = Ensure-ObjectProperty $pluginConfig "resourceAttributes"
    if ($null -eq (Get-PropertyValue $resources "agent_runtime")) { Set-ObjectProperty $resources "agent_runtime" "openclaw" }
    foreach ($item in $Tag) {
      $parts = $item -split "=", 2
      if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0])) { throw "[install] invalid tag '$item'; expected KEY=VALUE" }
      Set-ObjectProperty $resources $parts[0] $parts[1]
    }
    if ($Type -eq "gtrace") {
      Set-ObjectProperty $pluginConfig "tracePath" "v1/write/otel-llm"
      Set-ObjectProperty $pluginConfig "metricsPath" "v1/write/otel-metrics"
      Set-ObjectProperty $pluginConfig "logsEnabled" $false
      Set-ObjectProperty $pluginConfig "logsPath" "v1/write/otel-logs"
      $headers = Ensure-ObjectProperty $pluginConfig "headers"
      Set-ObjectProperty $headers "to_headless" "true"
      if ($XToken) { Set-ObjectProperty $headers "X-Token" $XToken }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $ConfigFile) -Force | Out-Null
    $config | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ConfigFile -Encoding UTF8
    Write-InstallLog "updated $ConfigFile"
  }

  Write-InstallLog "install type: $Type"
  if (-not $NoRestart) {
    if (Get-Command openclaw -ErrorAction SilentlyContinue) {
      Write-InstallLog "restarting openclaw gateway"
      & openclaw gateway restart
    } else {
      Write-InstallLog "openclaw command was not found, skipping gateway restart"
    }
  }
} finally {
  if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
