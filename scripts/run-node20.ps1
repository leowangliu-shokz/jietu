param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$NodeArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$toolsRoot = Join-Path $repoRoot "logs\tool-cache"
$legacyToolsRoot = Join-Path $repoRoot "logs\node20-test"
$version = "v20.20.2"
$distName = "node-v20.20.2-win-x64"
$distDir = Join-Path $toolsRoot $distName
$nodeExe = Join-Path $distDir "node.exe"
$legacyNodeExe = Join-Path (Join-Path $legacyToolsRoot $distName) "node.exe"
$zipPath = Join-Path $toolsRoot "$distName.zip"
$downloadUrl = "https://nodejs.org/dist/$version/$distName.zip"

if (!(Test-Path $nodeExe)) {
  New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
  if (Test-Path $legacyNodeExe) {
    Copy-Item -Path (Split-Path -Parent $legacyNodeExe) -Destination $distDir -Recurse -Force
  } elseif (!(Test-Path $zipPath)) {
    Invoke-WebRequest -UseBasicParsing $downloadUrl -OutFile $zipPath
    Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsRoot -Force
  } else {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsRoot -Force
  }
}

& $nodeExe --experimental-websocket @NodeArgs
exit $LASTEXITCODE
