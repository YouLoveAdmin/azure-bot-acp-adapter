[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$EnvFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.env'),
  [string]$UpstreamBuildEnvFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.env.upstream.env'),
  [ValidateRange(1, 120)]
  [int]$CommandTimeoutMinutes = 30,
  [ValidateRange(1, 240)]
  [int]$BuildTimeoutMinutes = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [System.IO.Path]::IsPathRooted($UpstreamBuildEnvFile)) {
  $UpstreamBuildEnvFile = Join-Path $RepoRoot $UpstreamBuildEnvFile
}

$UpstreamBuildEnvFile = [System.IO.Path]::GetFullPath($UpstreamBuildEnvFile)

function Assert-Command {
  param([Parameter(Mandatory=$true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Test-DockerDaemon {
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Format-NativeCommandForError {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string[]]$Arguments
  )

  $sensitiveFlags = @(
    '--account-key',
    '--azure-file-account-key',
    '--client-secret',
    '--password',
    '--token'
  )
  $safeArguments = @($Arguments)
  for ($index = 0; $index -lt $safeArguments.Count - 1; $index++) {
    if ($sensitiveFlags -contains $safeArguments[$index]) {
      $safeArguments[$index + 1] = '[REDACTED]'
      $index++
    }
  }

  return "$Name $($safeArguments -join ' ')"
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [ValidateRange(1, 7200)][int]$TimeoutSeconds = 600
  )

  $command = Get-Command $Name -ErrorAction Stop
  $commandPath = if ($command.Source) { $command.Source } else { $command.Path }
  if ([string]::IsNullOrWhiteSpace($commandPath)) {
    throw "Unable to resolve command path: $Name"
  }
  $safeCommand = Format-NativeCommandForError -Name $Name -Arguments $Arguments

  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $commandPath
  $processInfo.WorkingDirectory = $RepoRoot
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true

  foreach ($argument in $Arguments) {
    $processInfo.ArgumentList.Add($argument)
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $processInfo

  if (-not $process.Start()) {
    throw "Unable to start command: $Name"
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $stdoutComplete = $false
  $stderrComplete = $false
  $stdoutTask = $process.StandardOutput.ReadLineAsync()
  $stderrTask = $process.StandardError.ReadLineAsync()

  while (-not ($process.HasExited -and $stdoutComplete -and $stderrComplete)) {
    if ([DateTime]::UtcNow -gt $deadline) {
      $process.Kill($true)
      $process.WaitForExit()
      throw "Command timed out after $TimeoutSeconds seconds: $safeCommand"
    }

    if (-not $stdoutComplete -and $stdoutTask.IsCompleted) {
      $stdoutLine = $stdoutTask.GetAwaiter().GetResult()
      if ($null -eq $stdoutLine) {
        $stdoutComplete = $true
      } else {
        Write-Host $stdoutLine
        $stdoutTask = $process.StandardOutput.ReadLineAsync()
      }
    }

    if (-not $stderrComplete -and $stderrTask.IsCompleted) {
      $stderrLine = $stderrTask.GetAwaiter().GetResult()
      if ($null -eq $stderrLine) {
        $stderrComplete = $true
      } else {
        Write-Host $stderrLine
        $stderrTask = $process.StandardError.ReadLineAsync()
      }
    }

    if (-not $process.HasExited -or -not $stdoutComplete -or -not $stderrComplete) {
      Start-Sleep -Milliseconds 100
    }
  }

  if (-not $process.HasExited) {
    $process.Kill($true)
    $process.WaitForExit()
    throw "Command ended unexpectedly while collecting output: $safeCommand"
  }

  if ($process.ExitCode -ne 0) {
    throw "Command failed with exit code $($process.ExitCode): $safeCommand"
  }
}

function Read-EnvFile {
  param([Parameter(Mandatory=$true)][string]$Path)
  if (-not (Test-Path $Path)) {
    throw "Missing .env at $Path"
  }

  $values = @{}
  foreach ($line in Get-Content -Path $Path) {
    $trimmed = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) {
      continue
    }

    $index = $line.IndexOf('=')
    if ($index -lt 1) {
      continue
    }

    $key = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1)
    $values[$key] = $value
  }

  return $values
}

function Get-EnvValue {
  param(
    [Parameter(Mandatory=$true)][hashtable]$Values,
    [Parameter(Mandatory=$true)][string]$Key,
    [string]$Default = ''
  )

  if ($Values.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace($Values[$Key])) {
    return [string]$Values[$Key]
  }

  return $Default
}

function Require-EnvValue {
  param(
    [Parameter(Mandatory=$true)][hashtable]$Values,
    [Parameter(Mandatory=$true)][string]$Key
  )

  if (-not $Values.ContainsKey($Key) -or [string]::IsNullOrWhiteSpace([string]$Values[$Key])) {
    throw "Missing required .env value: $Key"
  }

  return [string]$Values[$Key]
}

function Add-EnvPair {
  param(
    [Parameter(Mandatory=$true)][System.Collections.Generic.List[object]]$List,
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$Value
  )

  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $List.Add([ordered]@{ name = $Name; value = $Value }) | Out-Null
  }
}

function Merge-EnvValues {
  param(
    [Parameter(Mandatory=$true)][hashtable]$Target,
    [Parameter(Mandatory=$true)][hashtable]$Source,
    [string[]]$ExcludePrefixes = @(),
    [string[]]$ExcludeKeys = @()
  )

  foreach ($entry in $Source.GetEnumerator()) {
    $key = [string]$entry.Key
    if ([string]::IsNullOrWhiteSpace($key)) {
      continue
    }

    if ($ExcludeKeys -contains $key) {
      continue
    }

    $skip = $false
    foreach ($prefix in $ExcludePrefixes) {
      if (-not [string]::IsNullOrWhiteSpace($prefix) -and $key.StartsWith($prefix)) {
        $skip = $true
        break
      }
    }

    if ($skip) {
      continue
    }

    $Target[$key] = [string]$entry.Value
  }
}

function Convert-EnvMapToPairs {
  param([Parameter(Mandatory=$true)][hashtable]$Values)

  $pairs = @()
  if ($null -eq $Values -or $Values.Count -eq 0) {
    return $pairs
  }

  foreach ($entry in $Values.GetEnumerator()) {
    $pairs += [ordered]@{ name = ([string]$entry.Key); value = ([string]$entry.Value) }
  }

  return $pairs
}

function ConvertTo-JsonCompressed {
  param([Parameter(Mandatory=$true)]$InputObject)
  return ($InputObject | ConvertTo-Json -Compress -Depth 20)
}

Assert-Command -Name az
Assert-Command -Name git
$dockerAvailable = (Get-Command docker -ErrorAction SilentlyContinue) -and (Test-DockerDaemon)
if (-not $dockerAvailable) {
  Write-Host 'Docker daemon is unavailable; images will be built remotely with ACR Tasks.'
}

$envValues = Read-EnvFile -Path $EnvFile

$subscriptionId = Get-EnvValue -Values $envValues -Key 'AZURE_SUBSCRIPTION_ID'
$resourceGroup = Require-EnvValue -Values $envValues -Key 'AZURE_RESOURCE_GROUP'
$location = Get-EnvValue -Values $envValues -Key 'AZURE_LOCATION' -Default 'eastus'
$envName = Get-EnvValue -Values $envValues -Key 'AZURE_ENV' -Default 'dev'
$logAnalytics = Get-EnvValue -Values $envValues -Key 'AZURE_LOG_ANALYTICS'
$containerAppName = Require-EnvValue -Values $envValues -Key 'AZURE_CONTAINER_APP_NAME'
$containerAppsEnvironment = Require-EnvValue -Values $envValues -Key 'AZURE_CONTAINER_APPS_ENVIRONMENT'
$containerRegistry = Require-EnvValue -Values $envValues -Key 'AZURE_CONTAINER_REGISTRY'
$mainImageName = Get-EnvValue -Values $envValues -Key 'AZURE_MAIN_IMAGE_NAME' -Default 'azure-chatbot-websocket'
$mainContainerName = Get-EnvValue -Values $envValues -Key 'AZURE_MAIN_CONTAINER_NAME' -Default 'bot'
$upstreamRepo = Require-EnvValue -Values $envValues -Key 'AZURE_UPSTREAM_GITHUB_REPO'
$upstreamImageName = Get-EnvValue -Values $envValues -Key 'AZURE_UPSTREAM_IMAGE_NAME' -Default 'github-copilot-acp-container-server'
$upstreamContainerName = Get-EnvValue -Values $envValues -Key 'AZURE_UPSTREAM_CONTAINER_NAME' -Default 'upstream'
$upstreamPort = Get-EnvValue -Values $envValues -Key 'AZURE_UPSTREAM_PORT' -Default '8080'
$upstreamEnvKeys = Get-EnvValue -Values $envValues -Key 'AZURE_UPSTREAM_ENV_KEYS'
$upstreamAppDataRootOverride = Get-EnvValue -Values $envValues -Key 'UPSTREAM_APPDATA_ROOT'
$azureFileStorageName = Get-EnvValue -Values $envValues -Key 'AZURE_FILE_STORAGE_NAME' -Default 'appdata'
$azureFileShareName = Get-EnvValue -Values $envValues -Key 'AZURE_FILE_SHARE_NAME'
$azureStorageAccountName = Get-EnvValue -Values $envValues -Key 'AZURE_STORAGE_ACCOUNT_NAME'
$azureStorageAccountKey = Get-EnvValue -Values $envValues -Key 'AZURE_STORAGE_ACCOUNT_KEY'
$azureFileAccessMode = Get-EnvValue -Values $envValues -Key 'AZURE_FILE_ACCESS_MODE' -Default 'ReadWrite'
$useAzureFileVolume = -not [string]::IsNullOrWhiteSpace($azureFileShareName) -or `
  -not [string]::IsNullOrWhiteSpace($azureStorageAccountName) -or `
  -not [string]::IsNullOrWhiteSpace($azureStorageAccountKey)
$upstreamRuntimeEnvValues = @{}
if (Test-Path $UpstreamBuildEnvFile) {
  $upstreamRuntimeEnvValues = Read-EnvFile -Path $UpstreamBuildEnvFile
}

if ($useAzureFileVolume) {
  if ([string]::IsNullOrWhiteSpace($azureFileShareName) -or [string]::IsNullOrWhiteSpace($azureStorageAccountName) -or [string]::IsNullOrWhiteSpace($azureStorageAccountKey)) {
    throw 'When using Azure File volume mounting, AZURE_FILE_SHARE_NAME, AZURE_STORAGE_ACCOUNT_NAME, and AZURE_STORAGE_ACCOUNT_KEY are all required.'
  }
}

if (-not [string]::IsNullOrWhiteSpace($subscriptionId)) {
  az account set --subscription $subscriptionId | Out-Null
}

$mainImageTag = $null
$upstreamImageTag = $null

az group show -n $resourceGroup *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-NativeCommand -Name 'az' -Arguments @('group', 'create', '-n', $resourceGroup, '-l', $location) -TimeoutSeconds 300
}

az acr show -n $containerRegistry *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-NativeCommand -Name 'az' -Arguments @('acr', 'create', '--resource-group', $resourceGroup, '--name', $containerRegistry, '--sku', 'Basic', '--location', $location) -TimeoutSeconds 600
}

$acrLoginServer = az acr show -n $containerRegistry --query loginServer -o tsv
if ([string]::IsNullOrWhiteSpace($acrLoginServer)) {
  throw "Unable to resolve ACR login server for $containerRegistry"
}

if ($logAnalytics -and -not (az monitor log-analytics workspace show -g $resourceGroup -n $logAnalytics 2>$null)) {
  az monitor log-analytics workspace create --resource-group $resourceGroup --workspace-name $logAnalytics --location $location | Out-Null
}

if ($envValues.ContainsKey('WEBSOCKET_USER') -and $envValues.ContainsKey('WEBSOCKET_AUTH_TOKEN')) {
  Write-Host 'Using WEBSOCKET_USER and WEBSOCKET_AUTH_TOKEN from .env'
}

$shortSha = (git rev-parse --short HEAD).Trim()
$mainImageTag = "$acrLoginServer/$mainImageName`:$shortSha"
$upstreamImageTag = "$acrLoginServer/$upstreamImageName`:latest"

$upstreamCloneDir = Join-Path $RepoRoot '.tmp-upstream-src'
if (Test-Path $upstreamCloneDir) {
  Remove-Item -Recurse -Force $upstreamCloneDir
}

$mainAcrContextDir = Join-Path $RepoRoot '.tmp-acr-main-context'
if (Test-Path $mainAcrContextDir) {
  Remove-Item -Recurse -Force $mainAcrContextDir
}

Invoke-NativeCommand -Name 'git' -Arguments @('-c', 'core.autocrlf=false', 'clone', $upstreamRepo, $upstreamCloneDir) -TimeoutSeconds 300

$upstreamDockerfile = Join-Path $upstreamCloneDir 'Dockerfile'
if (-not (Test-Path $upstreamDockerfile)) {
  throw "Upstream repo does not contain a Dockerfile: $upstreamRepo"
}

$upstreamEntrypoint = Join-Path $upstreamCloneDir 'start-acp.sh'
if (-not (Test-Path $upstreamEntrypoint)) {
  throw "Upstream repo does not contain start-acp.sh: $upstreamRepo"
}

$upstreamVolumeRemapScript = Join-Path $upstreamCloneDir 'aca-volume-remap.sh'
$upstreamVolumeRemapScriptContent = @'
#!/bin/sh
set -eu

appdata_root="${UPSTREAM_APPDATA_ROOT:-/appdata/upstream}"
workspace_dir="${appdata_root}/workspace"
host_repo_dir="${appdata_root}/host-repo"

mkdir -p "${workspace_dir}" "${host_repo_dir}" /root/.copilot
rm -rf /workspace /host-repo
ln -s "${workspace_dir}" /workspace
ln -s "${host_repo_dir}" /host-repo

echo "[aca-volume-remap] /workspace -> $(readlink /workspace)"
echo "[aca-volume-remap] /root/.copilot -> local (/root/.copilot)"
echo "[aca-volume-remap] /host-repo -> $(readlink /host-repo)"

exec /usr/local/bin/start-acp.sh "$@"
'@
$upstreamVolumeRemapScriptContent = $upstreamVolumeRemapScriptContent -replace "`r`n", "`n"
[System.IO.File]::WriteAllText(
  $upstreamVolumeRemapScript,
  $upstreamVolumeRemapScriptContent,
  [System.Text.UTF8Encoding]::new($false)
)

$upstreamRemapBytes = [System.IO.File]::ReadAllBytes($upstreamVolumeRemapScript)
if ($upstreamRemapBytes.Length -ge 3 -and $upstreamRemapBytes[2] -eq 13) {
  throw 'Generated aca-volume-remap.sh has a CRLF shebang and cannot execute in the Linux container.'
}

$upstreamDockerfileContent = Get-Content -Path $upstreamDockerfile -Raw
if (-not $upstreamDockerfileContent.Contains('aca-volume-remap.sh')) {
  $upstreamDockerfileContent = $upstreamDockerfileContent.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + @'
COPY aca-volume-remap.sh /usr/local/bin/aca-volume-remap.sh
RUN chmod +x /usr/local/bin/aca-volume-remap.sh
ENTRYPOINT ["/usr/local/bin/aca-volume-remap.sh"]
'@
  Set-Content -Path $upstreamDockerfile -Value $upstreamDockerfileContent -Encoding utf8
}

$entrypointBytes = [System.IO.File]::ReadAllBytes($upstreamEntrypoint)
if ($entrypointBytes.Length -ge 3 -and $entrypointBytes[2] -eq 13) {
  throw 'Upstream start-acp.sh has a CRLF shebang and cannot execute in the Linux container.'
}

Write-Host "Building main image: $mainImageTag"
if ($dockerAvailable) {
  Invoke-NativeCommand -Name 'docker' -Arguments @('build', '-t', $mainImageTag, '-f', (Join-Path $RepoRoot 'Dockerfile'), $RepoRoot) -TimeoutSeconds ($BuildTimeoutMinutes * 60)

  Write-Host "Building upstream image: $upstreamImageTag"
  Invoke-NativeCommand -Name 'docker' -Arguments @('build', '-t', $upstreamImageTag, '-f', $upstreamDockerfile, $upstreamCloneDir) -TimeoutSeconds ($BuildTimeoutMinutes * 60)

  Write-Host 'Pushing images to ACR'
  Invoke-NativeCommand -Name 'az' -Arguments @('acr', 'login', '-n', $containerRegistry) -TimeoutSeconds 300
  Invoke-NativeCommand -Name 'docker' -Arguments @('push', $mainImageTag) -TimeoutSeconds ($BuildTimeoutMinutes * 60)
  Invoke-NativeCommand -Name 'docker' -Arguments @('push', $upstreamImageTag) -TimeoutSeconds ($BuildTimeoutMinutes * 60)
} else {
  New-Item -ItemType Directory -Path $mainAcrContextDir -Force | Out-Null
  Copy-Item -Path (Join-Path $RepoRoot 'Dockerfile') -Destination $mainAcrContextDir -Force
  Copy-Item -Path (Join-Path $RepoRoot 'package.json') -Destination $mainAcrContextDir -Force
  Copy-Item -Path (Join-Path $RepoRoot 'package-lock.json') -Destination $mainAcrContextDir -Force
  Copy-Item -Path (Join-Path $RepoRoot 'tsconfig.json') -Destination $mainAcrContextDir -Force
  Copy-Item -Path (Join-Path $RepoRoot 'src') -Destination (Join-Path $mainAcrContextDir 'src') -Recurse -Force

  Invoke-NativeCommand -Name 'az' -Arguments @(
    'acr', 'build', '-r', $containerRegistry,
    '-t', "$mainImageName`:$shortSha",
    '-f', (Join-Path $mainAcrContextDir 'Dockerfile'),
    $mainAcrContextDir
  ) -TimeoutSeconds ($BuildTimeoutMinutes * 60)

  Write-Host "Building upstream image: $upstreamImageTag"
  Invoke-NativeCommand -Name 'az' -Arguments @(
    'acr', 'build', '-r', $containerRegistry,
    '-t', "$upstreamImageName`:latest",
    '-f', $upstreamDockerfile,
    $upstreamCloneDir
  ) -TimeoutSeconds ($BuildTimeoutMinutes * 60)
}

$botRuntimeEnvMap = @{}
Merge-EnvValues -Target $botRuntimeEnvMap -Source $envValues -ExcludePrefixes @('AZURE_') -ExcludeKeys @('WEBSOCKET_URL')
$botRuntimeEnvMap['WEBSOCKET_URL'] = "ws://127.0.0.1:$upstreamPort"
if ($useAzureFileVolume) {
  $botRuntimeEnvMap['LOG_DIR'] = "/appdata/$mainContainerName/logs"
}
$botEnvPairs = Convert-EnvMapToPairs -Values $botRuntimeEnvMap

$upstreamRuntimeEnvMap = @{}
Merge-EnvValues -Target $upstreamRuntimeEnvMap -Source $upstreamRuntimeEnvValues -ExcludePrefixes @('AZURE_')

if (-not [string]::IsNullOrWhiteSpace($upstreamEnvKeys)) {
  foreach ($rawKey in $upstreamEnvKeys.Split(',')) {
    $key = $rawKey.Trim()
    if ($key) {
      $value = Get-EnvValue -Values $envValues -Key $key
      if ($value) {
        $upstreamRuntimeEnvMap[$key] = $value
      }
    }
  }
}

$upstreamEnvPairs = Convert-EnvMapToPairs -Values $upstreamRuntimeEnvMap

$mainContainerTemplate = [ordered]@{
  name = $mainContainerName
  image = $mainImageTag
  env = $botEnvPairs
}

$upstreamContainerTemplate = [ordered]@{
  name = $upstreamContainerName
  image = $upstreamImageTag
  env = $upstreamEnvPairs
}

az containerapp show -g $resourceGroup -n $containerAppName *> $null
$containerAppExists = $LASTEXITCODE -eq 0

$preservedTemplateVolumes = @()
$preservedMainVolumeMounts = @()
$preservedUpstreamVolumeMounts = @()

if ($containerAppExists) {
  $existingTemplateJson = az containerapp show -g $resourceGroup -n $containerAppName --query properties.template -o json
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingTemplateJson)) {
    try {
      $existingTemplate = $existingTemplateJson | ConvertFrom-Json -AsHashtable -Depth 50

      if ($existingTemplate.ContainsKey('volumes') -and $existingTemplate['volumes']) {
        $preservedTemplateVolumes = @($existingTemplate['volumes'])
      }

      if ($existingTemplate.ContainsKey('containers') -and $existingTemplate['containers']) {
        foreach ($container in $existingTemplate['containers']) {
          if ($null -eq $container -or -not $container.ContainsKey('name') -or -not $container.ContainsKey('volumeMounts') -or -not $container['volumeMounts']) {
            continue
          }

          $containerName = [string]$container['name']
          if ($containerName -eq $mainContainerName) {
            $preservedMainVolumeMounts = @($container['volumeMounts'])
          } elseif ($containerName -eq $upstreamContainerName) {
            $preservedUpstreamVolumeMounts = @($container['volumeMounts'])
          }
        }
      }
    } catch {
      Write-Host "Warning: unable to parse existing Container App template for mount preservation: $($_.Exception.Message)"
    }
  }
}

$preservedMainHasAppDataMount = $false
foreach ($mount in $preservedMainVolumeMounts) {
  if ($null -ne $mount -and $mount.ContainsKey('mountPath') -and [string]$mount['mountPath'] -eq '/appdata') {
    $preservedMainHasAppDataMount = $true
    break
  }
}

$preservedUpstreamHasAppDataMount = $false
foreach ($mount in $preservedUpstreamVolumeMounts) {
  if ($null -ne $mount -and $mount.ContainsKey('mountPath') -and [string]$mount['mountPath'] -eq '/appdata') {
    $preservedUpstreamHasAppDataMount = $true
    break
  }
}

$shouldUseMainAppData = $useAzureFileVolume -or $preservedMainHasAppDataMount
$shouldUseUpstreamAppData = $useAzureFileVolume -or $preservedUpstreamHasAppDataMount

if ($shouldUseMainAppData) {
  $botRuntimeEnvMap['LOG_DIR'] = "/appdata/$mainContainerName/logs"
  $botEnvPairs = Convert-EnvMapToPairs -Values $botRuntimeEnvMap
  $mainContainerTemplate['env'] = $botEnvPairs
}

if ($shouldUseUpstreamAppData) {
  $resolvedUpstreamAppDataRoot = if (-not [string]::IsNullOrWhiteSpace($upstreamAppDataRootOverride)) {
    $upstreamAppDataRootOverride
  } else {
    "/appdata/$upstreamContainerName"
  }

  $upstreamRuntimeEnvMap['UPSTREAM_APPDATA_ROOT'] = $resolvedUpstreamAppDataRoot
  $upstreamEnvPairs = Convert-EnvMapToPairs -Values $upstreamRuntimeEnvMap
  $upstreamContainerTemplate['env'] = $upstreamEnvPairs
}

az containerapp env show -g $resourceGroup -n $containerAppsEnvironment *> $null
$envExists = $LASTEXITCODE -eq 0

if (-not $envExists) {
  Invoke-NativeCommand -Name 'az' -Arguments @('containerapp', 'env', 'create', '-g', $resourceGroup, '-n', $containerAppsEnvironment, '-l', $location) -TimeoutSeconds 900
}

$environmentId = az containerapp env show -g $resourceGroup -n $containerAppsEnvironment --query id -o tsv
if ([string]::IsNullOrWhiteSpace($environmentId)) {
  throw "Unable to resolve Container Apps environment id for $containerAppsEnvironment"
}

if ($useAzureFileVolume) {
  Write-Host "Configuring Azure File storage '$azureFileStorageName' in Container Apps environment"
  Invoke-NativeCommand -Name 'az' -Arguments @(
    'containerapp', 'env', 'storage', 'set',
    '-g', $resourceGroup,
    '-n', $containerAppsEnvironment,
    '--storage-name', $azureFileStorageName,
    '--azure-file-account-name', $azureStorageAccountName,
    '--azure-file-account-key', $azureStorageAccountKey,
    '--azure-file-share-name', $azureFileShareName,
    '--access-mode', $azureFileAccessMode
  ) -TimeoutSeconds 300

  # Ensure each container has a dedicated folder in the shared volume before deployment.
  Invoke-NativeCommand -Name 'az' -Arguments @(
    'storage', 'directory', 'create',
    '--account-name', $azureStorageAccountName,
    '--account-key', $azureStorageAccountKey,
    '--share-name', $azureFileShareName,
    '--name', $mainContainerName
  ) -TimeoutSeconds 120

  Invoke-NativeCommand -Name 'az' -Arguments @(
    'storage', 'directory', 'create',
    '--account-name', $azureStorageAccountName,
    '--account-key', $azureStorageAccountKey,
    '--share-name', $azureFileShareName,
    '--name', "$mainContainerName/logs"
  ) -TimeoutSeconds 120

  Invoke-NativeCommand -Name 'az' -Arguments @(
    'storage', 'directory', 'create',
    '--account-name', $azureStorageAccountName,
    '--account-key', $azureStorageAccountKey,
    '--share-name', $azureFileShareName,
    '--name', $upstreamContainerName
  ) -TimeoutSeconds 120

  Invoke-NativeCommand -Name 'az' -Arguments @(
    'storage', 'directory', 'create',
    '--account-name', $azureStorageAccountName,
    '--account-key', $azureStorageAccountKey,
    '--share-name', $azureFileShareName,
    '--name', "$upstreamContainerName/workspace"
  ) -TimeoutSeconds 120

  Invoke-NativeCommand -Name 'az' -Arguments @(
    'storage', 'directory', 'create',
    '--account-name', $azureStorageAccountName,
    '--account-key', $azureStorageAccountKey,
    '--share-name', $azureFileShareName,
    '--name', "$upstreamContainerName/copilot-home"
  ) -TimeoutSeconds 120

  Invoke-NativeCommand -Name 'az' -Arguments @(
    'storage', 'directory', 'create',
    '--account-name', $azureStorageAccountName,
    '--account-key', $azureStorageAccountKey,
    '--share-name', $azureFileShareName,
    '--name', "$upstreamContainerName/host-repo"
  ) -TimeoutSeconds 120
}

if (-not $containerAppExists) {
  Write-Host 'Creating Container App identity before deploying private ACR images'
  Invoke-NativeCommand -Name 'az' -Arguments @(
    'containerapp', 'create', '-g', $resourceGroup, '-n', $containerAppName,
    '--environment', $containerAppsEnvironment,
    '--image', 'mcr.microsoft.com/k8se/quickstart:latest',
    '--ingress', 'external', '--target-port', '80',
    '--system-assigned'
  ) -TimeoutSeconds 900
  $containerAppExists = $true
}

$containerAppPrincipalId = (az containerapp identity show -g $resourceGroup -n $containerAppName --query principalId -o tsv).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerAppPrincipalId)) {
  throw "Unable to resolve managed identity for Container App $containerAppName"
}

$acrId = (az acr show -n $containerRegistry --query id -o tsv).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($acrId)) {
  throw "Unable to resolve ACR resource id for $containerRegistry"
}

$acrPullAssignment = az role assignment list --assignee-object-id $containerAppPrincipalId --scope $acrId --role AcrPull --query '[0].id' -o tsv
if ($LASTEXITCODE -ne 0) {
  throw "Unable to inspect AcrPull role assignment for $containerAppName"
}
if ([string]::IsNullOrWhiteSpace($acrPullAssignment)) {
  Invoke-NativeCommand -Name 'az' -Arguments @(
    'role', 'assignment', 'create',
    '--assignee-object-id', $containerAppPrincipalId,
    '--assignee-principal-type', 'ServicePrincipal',
    '--scope', $acrId,
    '--role', 'AcrPull'
  ) -TimeoutSeconds 300
}

$mergedTemplateVolumes = @()
$volumeIndex = @{}
foreach ($volume in $preservedTemplateVolumes) {
  if ($null -eq $volume -or -not $volume.ContainsKey('name')) {
    continue
  }

  $volumeName = [string]$volume['name']
  if ([string]::IsNullOrWhiteSpace($volumeName) -or $volumeIndex.ContainsKey($volumeName)) {
    continue
  }

  $volumeIndex[$volumeName] = $true
  $mergedTemplateVolumes += $volume
}

if ($useAzureFileVolume -and -not $volumeIndex.ContainsKey($azureFileStorageName)) {
  $volumeIndex[$azureFileStorageName] = $true
  $mergedTemplateVolumes += [ordered]@{
    name = $azureFileStorageName
    storageType = 'AzureFile'
    storageName = $azureFileStorageName
  }
}

$mergedMainVolumeMounts = @()
$mainMountIndex = @{}
foreach ($mount in $preservedMainVolumeMounts) {
  if ($null -eq $mount -or -not $mount.ContainsKey('volumeName') -or -not $mount.ContainsKey('mountPath')) {
    continue
  }

  $mountKey = "{0}|{1}" -f ([string]$mount['volumeName']), ([string]$mount['mountPath'])
  if ($mainMountIndex.ContainsKey($mountKey)) {
    continue
  }

  $mainMountIndex[$mountKey] = $true
  $mergedMainVolumeMounts += $mount
}

if ($useAzureFileVolume) {
  $appdataMainMountKey = "$azureFileStorageName|/appdata"
  if (-not $mainMountIndex.ContainsKey($appdataMainMountKey)) {
    $mainMountIndex[$appdataMainMountKey] = $true
    $mergedMainVolumeMounts += [ordered]@{
      volumeName = $azureFileStorageName
      mountPath = '/appdata'
    }
  }
}

if ($mergedMainVolumeMounts.Count -gt 0) {
  $mainContainerTemplate['volumeMounts'] = $mergedMainVolumeMounts
}

$mergedUpstreamVolumeMounts = @()
$upstreamMountIndex = @{}
foreach ($mount in $preservedUpstreamVolumeMounts) {
  if ($null -eq $mount -or -not $mount.ContainsKey('volumeName') -or -not $mount.ContainsKey('mountPath')) {
    continue
  }

  $mountKey = "{0}|{1}" -f ([string]$mount['volumeName']), ([string]$mount['mountPath'])
  if ($upstreamMountIndex.ContainsKey($mountKey)) {
    continue
  }

  $upstreamMountIndex[$mountKey] = $true
  $mergedUpstreamVolumeMounts += $mount
}

if ($useAzureFileVolume) {
  $appdataUpstreamMountKey = "$azureFileStorageName|/appdata"
  if (-not $upstreamMountIndex.ContainsKey($appdataUpstreamMountKey)) {
    $upstreamMountIndex[$appdataUpstreamMountKey] = $true
    $mergedUpstreamVolumeMounts += [ordered]@{
      volumeName = $azureFileStorageName
      mountPath = '/appdata'
    }
  }
}

if ($mergedUpstreamVolumeMounts.Count -gt 0) {
  $upstreamContainerTemplate['volumeMounts'] = $mergedUpstreamVolumeMounts
}

$template = [ordered]@{
  location = $location
  identity = [ordered]@{
    type = 'SystemAssigned'
  }
  properties = [ordered]@{
    environmentId = $environmentId
    configuration = [ordered]@{
      ingress = [ordered]@{
        external = $true
        targetPort = 3978
        transport = 'auto'
      }
      registries = @(
        [ordered]@{
          server = $acrLoginServer
          identity = 'system'
        }
      )
      secrets = @()
    }
    template = [ordered]@{
      containers = @($mainContainerTemplate, $upstreamContainerTemplate)
    }
  }
}

if ($mergedTemplateVolumes.Count -gt 0) {
  $template.properties.template['volumes'] = $mergedTemplateVolumes
}

$templateFile = New-TemporaryFile
try {
  $templateJson = ConvertTo-JsonCompressed -InputObject $template
  Set-Content -Path $templateFile -Value $templateJson -Encoding utf8

  Write-Host "Updating Azure Container App: $containerAppName"
  if ($containerAppExists) {
    Invoke-NativeCommand -Name 'az' -Arguments @('containerapp', 'update', '-g', $resourceGroup, '-n', $containerAppName, '--yaml', [string]$templateFile) -TimeoutSeconds 900
  } else {
    Invoke-NativeCommand -Name 'az' -Arguments @('containerapp', 'create', '-g', $resourceGroup, '-n', $containerAppName, '--yaml', [string]$templateFile) -TimeoutSeconds 900
  }
} finally {
  Remove-Item -Force $templateFile -ErrorAction SilentlyContinue
}

Remove-Item -Recurse -Force $upstreamCloneDir
if (Test-Path $mainAcrContextDir) {
  Remove-Item -Recurse -Force $mainAcrContextDir
}

$fqdn = (az containerapp show -g $resourceGroup -n $containerAppName --query properties.configuration.ingress.fqdn -o tsv).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($fqdn)) {
  throw "Deployment completed without an ingress FQDN for $containerAppName"
}

$endpoint = "https://$fqdn"
$healthEndpoint = "$endpoint/healthz"
Write-Host "Waiting for HTTPS health endpoint: $healthEndpoint"
$healthy = $false
for ($attempt = 1; $attempt -le 18; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri $healthEndpoint -TimeoutSec 10 -UseBasicParsing
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      $healthy = $true
      break
    }
  } catch {
    Write-Host "Health check $attempt/18 not ready: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 10
}

if (-not $healthy) {
  az containerapp revision list -g $resourceGroup -n $containerAppName --query '[].{name:name,active:properties.active,healthState:properties.healthState,provisioningState:properties.provisioningState}' -o table
  az containerapp logs show -g $resourceGroup -n $containerAppName --tail 50
  throw "HTTPS health endpoint did not become ready: $healthEndpoint"
}

Write-Host "Deployment complete: $endpoint"
