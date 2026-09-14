[CmdletBinding()]
param(
  [ValidateSet('Launch', 'Start', 'StartCoordinator', 'StartMetro', 'StartHelper', 'ShowQr', 'Stop', 'Status')]
  [string]$Action = 'Status',
  [string]$LanAddress = '',
  [ValidateSet('tunnel', 'lan')]
  [string]$MetroMode = 'lan',
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$script:Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:Runtime = Join-Path $script:Root '.lectureai-runtime'
$script:Logs = Join-Path $script:Runtime 'logs'
$script:MetroStatePath = Join-Path $script:Runtime 'metro.json'
$script:HelperStatePath = Join-Path $script:Runtime 'laptop-ai.json'
$script:LauncherStatePath = Join-Path $script:Runtime 'launcher.json'
$script:RuntimeScript = [System.IO.Path]::GetFullPath($PSCommandPath)
$script:MetroQrPath = Join-Path $script:Runtime 'metro-qr.png'
$script:HelperQrPath = Join-Path $script:Runtime 'laptop-ai-pairing-qr.png'
$script:QrPagePath = Join-Path $script:Runtime 'lectureai-qr.html'
$script:LastLanPath = Join-Path $script:Runtime 'last-lan-address.txt'
$script:EmptyInputPath = Join-Path $script:Runtime 'empty.stdin'

New-Item -ItemType Directory -Path $script:Logs -Force | Out-Null
if (-not (Test-Path -LiteralPath $script:EmptyInputPath)) { New-Item -ItemType File -Path $script:EmptyInputPath | Out-Null }

function Get-StatePath([string]$Kind) {
  if ($Kind -eq 'metro') { return $script:MetroStatePath }
  if ($Kind -eq 'helper') { return $script:HelperStatePath }
  return $script:LauncherStatePath
}

function Get-OwnershipMarkers([string]$Kind) {
  if ($Kind -eq 'metro') {
    return @(
      [System.IO.Path]::GetFullPath((Join-Path $script:Root 'expo-recorder')),
      [System.IO.Path]::GetFullPath((Join-Path $script:Root 'expo-recorder\node_modules\expo\bin\cli')),
      '--port'
    )
  }
  if ($Kind -eq 'launcher') {
    return @(
      $script:RuntimeScript,
      '-Action',
      'StartCoordinator'
    )
  }
  return @(
    [System.IO.Path]::GetFullPath((Join-Path $script:Root 'local-ai\server.py')),
    '--lan',
    '--host'
  )
}

function Read-JsonFile([string]$Path, [switch]$RemoveIfInvalid) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch {
    if ($RemoveIfInvalid) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
    return $null
  }
}

function Write-JsonFile([string]$Path, [object]$Value) {
  $temporary = "$Path.tmp"
  $Value | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-ProcessRecord([int]$ProcessId) {
  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-SystemProcess([int]$ProcessId) {
  return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
}

function Test-CommandOwnership([object]$Process, [string]$Kind) {
  if (-not $Process -or -not $Process.CommandLine) { return $false }
  $command = [string]$Process.CommandLine
  foreach ($marker in Get-OwnershipMarkers $Kind) {
    if ($command.IndexOf([string]$marker, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  return $true
}

function Remove-StaleState([string]$Kind) {
  $path = Get-StatePath $Kind
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
    Write-Host "Removed stale $Kind PID state."
  }
}

function Get-ValidState([string]$Kind) {
  $path = Get-StatePath $Kind
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $state = Read-JsonFile $path -RemoveIfInvalid
  if (-not $state -or -not $state.processId -or [int]$state.schemaVersion -ne 1 -or [string]$state.kind -ne $Kind) {
    Write-Host "Discarding invalid $Kind state: missing or mismatched schema/identity."
    Remove-StaleState $Kind
    return $null
  }
  $systemProcess = Get-SystemProcess ([int]$state.processId)
  if (-not $systemProcess -or -not $state.processStartedAt -or -not $state.executablePath -or [string]$state.root -ne $script:Root) {
    Write-Host "Discarding invalid $Kind state: process, start time, executable, or checkout root no longer matches."
    Remove-StaleState $Kind
    return $null
  }
  $actualStart = $systemProcess.StartTime.ToUniversalTime()
  $startDeltaSeconds = 0.0
  if ($state.processStartTicksUtc) {
    $startDeltaSeconds = [Math]::Abs(([long]$actualStart.Ticks - [long]$state.processStartTicksUtc) / [double][TimeSpan]::TicksPerSecond)
  } else {
    try {
      $expectedStart = [DateTime]::ParseExact([string]$state.processStartedAt, 'o', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
      $startDeltaSeconds = [Math]::Abs(($actualStart - $expectedStart).TotalSeconds)
    } catch {
      Write-Host "Discarding invalid $Kind state: saved process start time is unreadable."
      Remove-StaleState $Kind
      return $null
    }
  }
  $sameStart = $startDeltaSeconds -lt 2
  $sameExecutable = [string]$systemProcess.Path -eq [string]$state.executablePath
  if (-not $sameStart -or -not $sameExecutable) {
    Write-Host "Discarding stale $Kind state: PID was reused or executable/start time changed (delta $([Math]::Round($startDeltaSeconds, 3)) seconds)."
    Remove-StaleState $Kind
    return $null
  }
  $cimProcess = Get-ProcessRecord ([int]$state.processId)
  if ($cimProcess -and -not (Test-CommandOwnership $cimProcess $Kind)) {
    Write-Host "Discarding stale $Kind state: command line no longer belongs to this LectureAI checkout."
    Remove-StaleState $Kind
    return $null
  }
  $state | Add-Member -NotePropertyName process -NotePropertyValue $systemProcess -Force
  return $state
}

function Find-OwnedProcess([string]$Kind) {
  $matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { Test-CommandOwnership $_ $Kind })
  if (-not $matches.Count) { return $null }
  return $matches | Sort-Object CreationDate, ProcessId | Select-Object -First 1
}

function Test-TcpPort([string]$Address, [int]$Port, [int]$TimeoutMs = 750) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect($Address, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false }
  finally { $client.Dispose() }
}

function Wait-ForPort([string]$Address, [int]$Port, [int]$ProcessId, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort $Address $Port) { return $true }
    if (-not (Get-SystemProcess $ProcessId)) { return $false }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Get-HttpHealthResponse([string]$Uri) {
  # Do not inherit npm/CLI proxy settings for local health checks. A stale or
  # sandbox proxy can otherwise make a healthy localhost Metro look unreachable.
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  try {
    $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{ ok = [bool]$response.IsSuccessStatusCode; content = [string]$content }
  } catch { return $null }
  finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Test-MetroHealth {
  $response = Get-HttpHealthResponse 'http://127.0.0.1:8081/status'
  return [bool]($response -and $response.ok -and ([string]$response.content).Trim() -match '^packager-status:running$')
}

function Test-MetroConnectionMode([int]$ProcessId, [string]$Mode) {
  $process = Get-ProcessRecord $ProcessId
  if (-not $process -or -not $process.CommandLine) { return $false }
  $expectedArgument = if ($Mode -eq 'lan') { '--lan' } else { '--tunnel' }
  return ([string]$process.CommandLine).IndexOf($expectedArgument, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Wait-ForMetroHealth([int]$ProcessId, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-MetroHealth) { return $true }
    if (-not (Get-SystemProcess $ProcessId)) { return $false }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Test-HelperHealth([string]$Address) {
  if (-not (Test-PrivateLanIpv4 $Address)) { return $false }
  try {
    $response = Get-HttpHealthResponse "http://${Address}:8765/health"
    if (-not $response -or -not $response.ok) { return $false }
    $payload = $response.content | ConvertFrom-Json
    return [bool]$payload.ok
  } catch { return $false }
}

function Wait-ForHelperHealth([string]$Address, [int]$ProcessId, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HelperHealth $Address) { return $true }
    if (-not (Get-SystemProcess $ProcessId)) { return $false }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Assert-PortAvailable([string]$Address, [int]$Port, [string]$Kind) {
  if (-not (Test-TcpPort $Address $Port)) { return }
  $owned = Find-OwnedProcess $Kind
  if ($owned) { return }
  throw "Port $Port is already in use by a process that is not owned by this LectureAI checkout. LectureAI did not stop or replace it."
}

function New-LogPaths([string]$Prefix) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  return @{
    stdout = Join-Path $script:Logs "$Prefix-$stamp.stdout.log"
    stderr = Join-Path $script:Logs "$Prefix-$stamp.stderr.log"
  }
}

function Quote-ProcessArgument([string]$Value) {
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Start-HiddenProcess([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [hashtable]$LogPaths) {
  $quoted = @($Arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) })
  return Start-Process -FilePath $Executable -ArgumentList $quoted -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardInput $script:EmptyInputPath -RedirectStandardOutput $LogPaths.stdout -RedirectStandardError $LogPaths.stderr -PassThru
}

function Get-WindowsPowerShellPath {
  $systemPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $systemPowerShell) { return $systemPowerShell }
  $command = Get-Command powershell.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { throw 'Windows PowerShell is required to start LectureAI in the background.' }
  return $command.Source
}

function Get-NodePath {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { throw 'Node.js is not installed or is not on PATH. Install the current Node.js LTS release, then run Start LectureAI again.' }
  return $command.Source
}

function Ensure-MetroDependencies([bool]$RequiresExpoLogin) {
  $node = Get-NodePath
  $project = Join-Path $script:Root 'expo-recorder'
  $expoPackage = Join-Path $project 'node_modules\expo\package.json'
  $version = if (Test-Path -LiteralPath $expoPackage) { (Get-Content -LiteralPath $expoPackage -Raw | ConvertFrom-Json).version } else { '' }
  if ([string]$version -notmatch '^57\.') {
    Write-Host 'Installing/upgrading LectureAI Expo SDK 57 dependencies...'
    & npm.cmd install --no-audit --no-fund --prefix $project
    if ($LASTEXITCODE -ne 0) { throw 'Expo dependency installation failed.' }
  }
  $cli = Join-Path $project 'node_modules\expo\bin\cli'
  if (-not (Test-Path -LiteralPath $cli)) { throw 'Expo CLI is missing after dependency setup.' }
  $user = ''
  if ($RequiresExpoLogin) {
    $user = & $node $cli whoami 2>$null | Select-Object -Last 1
    if (-not $user -or [string]$user -match 'Not logged in') {
      throw 'Expo CLI is not signed in. Run npx expo login once, then run Start LectureAI again.'
    }
  }
  return @{ node = $node; cli = $cli; project = $project; user = [string]$user }
}

function Get-PythonSetupCommand {
  $py = Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($py) { return @{ executable = $py.Source; arguments = @('-3') } }
  $python = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($python) { return @{ executable = $python.Source; arguments = @() } }
  throw 'Python 3.11 or newer was not found. Install it from python.org, then run Start LectureAI again.'
}

function Ensure-HelperDependencies {
  $venvPython = Join-Path $script:Root '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host 'Creating the private Laptop AI Python environment...'
    $setup = Get-PythonSetupCommand
    & $setup.executable @($setup.arguments) -m venv (Join-Path $script:Root '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed.' }
  }
  & $venvPython -c 'import av,fastapi,faster_whisper,numpy,qrcode,uvicorn' 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Installing missing Laptop AI requirements...'
    & $venvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed.' }
    & $venvPython -m pip install -r (Join-Path $script:Root 'local-ai\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Laptop AI dependency installation failed.' }
  }
  return $venvPython
}

function Test-PrivateLanIpv4([string]$Value) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed)) { return $false }
  if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  $bytes = $parsed.GetAddressBytes()
  return ($bytes[0] -eq 10) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31)
}

function Get-LanCandidates {
  $selector = Join-Path $script:Root 'local-ai\select_lan_ipv4.ps1'
  if (-not (Test-Path -LiteralPath $selector)) { throw 'The private-LAN selector is missing.' }
  $rows = @(& $selector)
  $items = foreach ($row in $rows) {
    $parts = [string]$row -split '\|', 2
    if ($parts.Count -eq 2 -and (Test-PrivateLanIpv4 $parts[0])) {
      [pscustomobject]@{ address = $parts[0]; name = $parts[1] }
    }
  }
  return @($items)
}

function Select-LanAddress([string]$Requested) {
  if ($Requested) {
    if (-not (Test-PrivateLanIpv4 $Requested)) { throw 'The requested address is not a strict RFC1918 private IPv4 address.' }
    return ([System.Net.IPAddress]::Parse($Requested)).IPAddressToString
  }
  $candidates = @(Get-LanCandidates)
  if (-not $candidates.Count) {
    throw 'LectureAI could not find a trusted private Wi-Fi/Ethernet address. No server was started and no firewall rule was changed.'
  }
  if (Test-Path -LiteralPath $script:LastLanPath) {
    $previous = (Get-Content -LiteralPath $script:LastLanPath -Raw).Trim()
    $match = $candidates | Where-Object address -eq $previous | Select-Object -First 1
    if ($match) { return $match.address }
  }
  if ($candidates.Count -eq 1) { return $candidates[0].address }
  if ($Action -eq 'StartCoordinator') {
    Write-Host "Multiple trusted private adapters are active; using the highest-ranked adapter $($candidates[0].name) ($($candidates[0].address))."
    return $candidates[0].address
  }
  Write-Host 'LectureAI found these trusted private network addresses:'
  for ($index = 0; $index -lt $candidates.Count; $index += 1) {
    Write-Host ("{0}. {1} - {2}" -f ($index + 1), $candidates[$index].name, $candidates[$index].address)
  }
  $selection = Read-Host 'Choose the network used by your iPhone/iPad'
  $number = 0
  if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $candidates.Count) {
    throw 'LectureAI did not receive a valid private-network selection. No server was started.'
  }
  return $candidates[$number - 1].address
}

function Get-CurrentLanAddress {
  $candidates = @(Get-LanCandidates)
  if (-not $candidates.Count) { return '' }
  $helper = Get-ValidState 'helper'
  if ($helper) {
    $match = $candidates | Where-Object address -eq ([string]$helper.address) | Select-Object -First 1
    if ($match) { return [string]$match.address }
  }
  if (Test-Path -LiteralPath $script:LastLanPath) {
    $previous = (Get-Content -LiteralPath $script:LastLanPath -Raw).Trim()
    $match = $candidates | Where-Object address -eq $previous | Select-Object -First 1
    if ($match) { return [string]$match.address }
  }
  if ($candidates.Count -eq 1) { return [string]$candidates[0].address }
  return ''
}

function Get-InstalledModel([string]$ModelName) {
  $cacheRoot = Join-Path $script:Root "models\models--Systran--faster-whisper-$ModelName"
  if (-not (Test-Path -LiteralPath $cacheRoot)) { return $null }
  $modelFile = Get-ChildItem -LiteralPath $cacheRoot -Filter 'model.bin' -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object Length -gt 100MB | Select-Object -First 1
  if (-not $modelFile -or -not (Test-Path -LiteralPath (Join-Path $modelFile.DirectoryName 'config.json'))) { return $null }
  return [pscustomobject]@{
    name = $ModelName
    path = $modelFile.DirectoryName
    sizeGb = [Math]::Round($modelFile.Length / 1GB, 2)
  }
}

function Show-ModelStatus {
  $medium = Get-InstalledModel 'medium'
  if ($medium) {
    Write-Host "faster-whisper Medium: INSTALLED ($($medium.sizeGb) GB model)"
    Write-Host "Model cache: $($medium.path)"
  } else {
    Write-Host "faster-whisper Medium: not present in LectureAI's model cache; it may download only when selected for transcription."
  }
}

function Save-ProcessState([string]$Kind, [object]$Process, [hashtable]$Extra) {
  $processId = if ($null -ne $Process.ProcessId) { [int]$Process.ProcessId } else { [int]$Process.Id }
  $systemProcess = Get-SystemProcess $processId
  if (-not $systemProcess) { throw "The new $Kind process exited before LectureAI could save its PID state." }
  $value = [ordered]@{
    schemaVersion = 1
    kind = $Kind
    processId = $processId
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    processStartedAt = $systemProcess.StartTime.ToUniversalTime().ToString('o')
    processStartTicksUtc = $systemProcess.StartTime.ToUniversalTime().Ticks
    executablePath = [string]$systemProcess.Path
    root = $script:Root
  }
  foreach ($key in $Extra.Keys) { $value[$key] = $Extra[$key] }
  Write-JsonFile (Get-StatePath $Kind) $value
  return Read-JsonFile (Get-StatePath $Kind) -RemoveIfInvalid
}

function Adopt-Process([string]$Kind, [object]$Process, [hashtable]$Extra) {
  Write-Host "Reusing an existing detached LectureAI $Kind process (PID $($Process.ProcessId))."
  return Save-ProcessState $Kind $Process $Extra
}

function Remove-OwnLauncherState {
  $state = Read-JsonFile $script:LauncherStatePath
  if ($state -and [int]$state.processId -eq $PID) {
    Remove-Item -LiteralPath $script:LauncherStatePath -Force -ErrorAction SilentlyContinue
  }
}

function Start-DetachedCoordinator([string]$RequestedAddress) {
  $state = Get-ValidState 'launcher'
  if ($state) {
    Write-Host "LectureAI startup is already continuing in the background (PID $($state.processId))."
    return $state
  }
  $existing = Find-OwnedProcess 'launcher'
  if ($existing) {
    return Adopt-Process 'launcher' $existing @{ stdoutLog = ''; stderrLog = ''; mode = $MetroMode }
  }
  $address = ''
  if ($RequestedAddress) {
    if (-not (Test-PrivateLanIpv4 $RequestedAddress)) { throw 'The requested address is not a strict RFC1918 private IPv4 address.' }
    $address = ([System.Net.IPAddress]::Parse($RequestedAddress)).IPAddressToString
  }
  $logs = New-LogPaths 'launcher'
  $powershell = Get-WindowsPowerShellPath
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script:RuntimeScript,
    '-Action', 'StartCoordinator',
    '-MetroMode', $MetroMode
  )
  if ($address) { $arguments += @('-LanAddress', $address) }
  $process = Start-HiddenProcess $powershell $arguments $script:Root $logs
  $state = Save-ProcessState 'launcher' $process @{ stdoutLog = $logs.stdout; stderrLog = $logs.stderr; address = $address; mode = $MetroMode }
  Write-Host "LectureAI startup is continuing in a detached hidden process (PID $($state.processId))."
  Write-Host 'This window can close now. The QR page will open automatically when both services are healthy.'
  Write-Host "Startup logs: $($logs.stdout) and $($logs.stderr)"
  return $state
}

function Start-Metro {
  $state = Get-ValidState 'metro'
  if ($state) {
    $sameMode = [string]$state.mode -eq $MetroMode
    $observedModeMatches = $sameMode -and (Test-MetroConnectionMode ([int]$state.processId) $MetroMode)
    if ($observedModeMatches -and (Test-MetroHealth -or (Wait-ForMetroHealth ([int]$state.processId) 8))) {
      Write-Host "Metro is already healthy in the background (PID $($state.processId)); reusing it."
      return $state
    }
    Write-Host 'Saved Metro is LectureAI-owned but unhealthy or using a different connection mode; replacing only its validated process tree.'
    Stop-OwnedTree 'metro'
  }
  $existing = Find-OwnedProcess 'metro'
  if ($existing) {
    $expectedConnectionArgument = if ($MetroMode -eq 'lan') { '--lan' } else { '--tunnel' }
    $observedModeMatches = ([string]$existing.CommandLine).IndexOf($expectedConnectionArgument, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $observedModeMatches) {
      throw "An untracked LectureAI Metro process exists in a different connection mode. It was not stopped because it did not have prior validated PID state."
    }
    $adopted = Adopt-Process 'metro' $existing @{ port = 8081; mode = $MetroMode; stdoutLog = ''; stderrLog = '' }
    if (Test-MetroHealth -or (Wait-ForMetroHealth ([int]$adopted.processId) 8)) { return $adopted }
    throw 'An untracked LectureAI Metro process exists but /status is not healthy. It was not stopped because it did not have prior validated PID state.'
  }
  Assert-PortAvailable '127.0.0.1' 8081 'metro'
  $setup = Ensure-MetroDependencies ($MetroMode -eq 'tunnel')
  $logs = New-LogPaths 'metro'
  $priorTelemetry = $env:EXPO_NO_TELEMETRY
  try {
    $env:EXPO_NO_TELEMETRY = '1'
    $connectionArgument = if ($MetroMode -eq 'lan') { '--lan' } else { '--tunnel' }
    $process = Start-HiddenProcess $setup.node @($setup.cli, 'start', '--clear', $connectionArgument, '--port', '8081') $setup.project $logs
  } finally {
    $env:EXPO_NO_TELEMETRY = $priorTelemetry
  }
  $state = Save-ProcessState 'metro' $process @{ port = 8081; mode = $MetroMode; stdoutLog = $logs.stdout; stderrLog = $logs.stderr; expoUser = $setup.user }
  if (-not (Wait-ForMetroHealth ([int]$state.processId) 150)) {
    Stop-OwnedTree 'metro'
    throw "Metro did not return packager-status:running from http://127.0.0.1:8081/status. Its logs are $($logs.stdout) and $($logs.stderr)."
  }
  Write-Host "Metro started as a detached hidden process (PID $($state.processId))."
  return $state
}

function Start-Helper([string]$RequestedAddress) {
  $address = Select-LanAddress $RequestedAddress
  if (-not (Test-PrivateLanIpv4 $address)) { throw 'Laptop AI refused a non-private IPv4 address.' }
  $state = Get-ValidState 'helper'
  if ($state) {
    $sameAddress = [string]$state.address -eq $address
    $healthy = $state.address -and ((Test-HelperHealth ([string]$state.address)) -or (Wait-ForHelperHealth ([string]$state.address) ([int]$state.processId) 8))
    if ($sameAddress -and $healthy) {
      Write-Host "Laptop AI is already running in the background (PID $($state.processId)); reusing it."
      return $state
    }
    # A laptop can change Wi-Fi/DHCP address while the saved owned process remains
    # alive on the old interface. The validated PID/start-time/command markers make
    # it safe to replace only that LectureAI-owned tree and preserve unrelated Python.
    Write-Host 'Laptop AI is owned by this checkout but is unhealthy or bound to an inactive private address; replacing only its validated process tree.'
    Stop-OwnedTree 'helper'
  }
  $existing = Find-OwnedProcess 'helper'
  if ($existing) {
    $match = [regex]::Match([string]$existing.CommandLine, '--host\s+"?(?<ip>\d{1,3}(?:\.\d{1,3}){3})')
    $existingAddress = if ($match.Success) { $match.Groups['ip'].Value } else { '' }
    if ($existingAddress -eq $address -and (Test-HelperHealth $existingAddress)) {
      return Adopt-Process 'helper' $existing @{ port = 8765; address = $existingAddress; qrPath = $script:HelperQrPath; stdoutLog = ''; stderrLog = '' }
    }
    throw 'An untracked LectureAI helper process is present but is not healthy on the selected private address. It was not stopped because no validated PID state exists.'
  }
  $python = Ensure-HelperDependencies
  Assert-PortAvailable $address 8765 'helper'
  Set-Content -LiteralPath $script:LastLanPath -Value $address -Encoding ASCII
  $logs = New-LogPaths 'laptop-ai'
  $server = Join-Path $script:Root 'local-ai\server.py'
  $process = Start-HiddenProcess $python @('-u', $server, '--lan', '--host', $address, '--port', '8765', '--pairing-qr-path', $script:HelperQrPath) $script:Root $logs
  $state = Save-ProcessState 'helper' $process @{ port = 8765; address = $address; qrPath = $script:HelperQrPath; stdoutLog = $logs.stdout; stderrLog = $logs.stderr }
  if (-not (Wait-ForHelperHealth $address ([int]$state.processId) 45)) {
    Stop-OwnedTree 'helper'
    throw "Laptop AI did not become healthy. Its logs are $($logs.stdout) and $($logs.stderr)."
  }
  Write-Host "Laptop AI started as a detached hidden process (PID $($state.processId)) on a validated private address."
  Write-Host 'Windows Firewall access, if requested, must be Private networks only - never Public networks.'
  return $state
}

function Get-MetroUrl([object]$State) {
  if ([string]$State.mode -eq 'lan' -and (Test-MetroHealth)) {
    $address = Get-CurrentLanAddress
    if ($address) { return "exp://${address}:8081" }
  }
  $logs = @($State.stdoutLog, $State.stderrLog) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $deadline = (Get-Date).AddSeconds(45)
  do {
    foreach ($log in $logs) {
      $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
      if ($null -eq $text) { $text = '' }
      $matches = [regex]::Matches($text, '(?i)\bexp(?:s)?://[^\s\x1b]+')
      if ($matches.Count) {
        return ($matches[$matches.Count - 1].Value -replace '[\)\],;]+$', '')
      }
    }
    $allText = ($logs | ForEach-Object { Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue }) -join "`n"
    if ([string]$State.mode -eq 'lan' -and $allText -match 'Waiting on http://localhost:8081') {
      $address = Get-CurrentLanAddress
      if ($address) { return "exp://${address}:8081" }
    }
    if ([string]$State.mode -eq 'tunnel' -and $allText -match 'Tunnel ready\.') {
      $settingsPath = Join-Path $script:Root 'expo-recorder\.expo\settings.json'
      $settings = Read-JsonFile $settingsPath
      $randomness = [string]$settings.urlRandomness
      $user = ([string]$State.expoUser).ToLowerInvariant() -replace '\.', '' -replace '[^a-z0-9-]', '-'
      if ($randomness -match '^[A-Za-z0-9_-]+$' -and $user -match '^[a-z0-9-]+$') {
        return "exp://${randomness}-${user}-8081.exp.direct"
      }
    }
    if (-not (Get-SystemProcess ([int]$State.processId))) { break }
    Start-Sleep -Milliseconds 350
  } while ((Get-Date) -lt $deadline)
  return ''
}

function Write-MetroQr([object]$State) {
  $url = Get-MetroUrl $State
  if (-not $url) { return $false }
  $urlPath = Join-Path $script:Runtime 'metro-url.txt'
  Set-Content -LiteralPath $urlPath -Value $url -Encoding ASCII
  $python = Join-Path $script:Root '.venv\Scripts\python.exe'
  $writer = Join-Path $script:Root 'local-ai\write_qr.py'
  if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $writer)) { return $false }
  & $python $writer --input $urlPath --output $script:MetroQrPath --label 'LectureAI Expo Go' | Out-Null
  return $LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $script:MetroQrPath)
}

function Write-QrPage([bool]$MetroReady, [bool]$HelperReady) {
  $cards = @()
  if ($MetroReady) {
    $metroUri = ([System.Uri]::new($script:MetroQrPath)).AbsoluteUri
    $cards += "<section><h2>Open LectureAI in Expo Go</h2><img src='$metroUri' alt='LectureAI Expo Go QR'><p>Scan with the iPhone/iPad Camera or Expo Go.</p></section>"
  } else {
    $cards += '<section><h2>Expo Metro is not running</h2><p>This helper-only launch keeps Laptop AI available. Use Start LectureAI.bat when you also need Expo Go.</p></section>'
  }
  if ($HelperReady) {
    $helperUri = ([System.Uri]::new($script:HelperQrPath)).AbsoluteUri
    $cards += "<section><h2>Pair Laptop AI</h2><img src='$helperUri' alt='LectureAI Laptop AI pairing QR'><p>In LectureAI: Settings &rarr; Windows transcription &rarr; Scan laptop QR.</p></section>"
  } else {
    $cards += '<section><h2>Laptop AI QR is unavailable</h2><p>Start LectureAI again and check the Laptop AI log if this persists.</p></section>'
  }
  $html = @"
<!doctype html><html><head><meta charset="utf-8"><title>LectureAI QR</title><style>
body{font-family:Segoe UI,Arial,sans-serif;background:#f4f7f5;color:#18332a;margin:0;padding:32px}main{max-width:980px;margin:auto}h1{margin:0 0 8px}p{line-height:1.5}div{display:flex;gap:24px;flex-wrap:wrap;margin-top:24px}section{background:white;border:1px solid #d8e2dd;border-radius:16px;padding:22px;flex:1;min-width:320px;box-shadow:0 8px 30px #18332a14}img{display:block;width:min(100%,420px);margin:16px auto;image-rendering:pixelated}.safe{font-weight:700;color:#276749}</style></head>
<body><main><h1>LectureAI is running in the background</h1><p class="safe">You can close this page. Closing it does not stop Metro or Laptop AI.</p><div>$($cards -join '')</div><p>Use <strong>Stop LectureAI.bat</strong> when you intentionally want to stop LectureAI's background processes.</p></main></body></html>
"@
  Set-Content -LiteralPath $script:QrPagePath -Value $html -Encoding UTF8
}

function Show-QrPage([switch]$AllowMissingMetro) {
  $metro = Get-ValidState 'metro'
  $helper = Get-ValidState 'helper'
  if (-not $metro) {
    $launcher = Get-ValidState 'launcher'
    if ($launcher) {
      $deadline = (Get-Date).AddSeconds(150)
      while (-not $metro -and (Get-Date) -lt $deadline -and (Get-SystemProcess ([int]$launcher.processId))) {
        Start-Sleep -Milliseconds 500
        $metro = Get-ValidState 'metro'
      }
      $helper = Get-ValidState 'helper'
    }
  }
  if (-not $metro -and -not $AllowMissingMetro) { throw 'Metro is not running under LectureAI ownership. Run Start LectureAI.bat first.' }
  $metroReady = $false
  if ($metro) {
    if (-not (Test-MetroHealth) -and -not (Wait-ForMetroHealth ([int]$metro.processId) 60)) {
      throw 'Metro did not become healthy within 60 seconds. Its saved logs remain available under .lectureai-runtime\logs.'
    }
    $metroReady = Write-MetroQr $metro
    if (-not $metroReady) { throw 'Metro is healthy, but LectureAI could not generate its Expo Go LAN QR. Check the current private network address and QR logs.' }
  }
  $helperReady = [bool]($helper -and (Test-HelperHealth ([string]$helper.address)) -and (Test-Path -LiteralPath $script:HelperQrPath))
  Write-QrPage $metroReady $helperReady
  if (-not $NoOpen) { Start-Process -FilePath $script:QrPagePath | Out-Null }
  Write-Host "QR page: $script:QrPagePath"
  Write-Host 'It is safe to close the QR page and this launcher window.'
}

function Stop-OwnedTree([string]$Kind) {
  $state = Get-ValidState $Kind
  if (-not $state) {
    Write-Host "$Kind is not running under LectureAI PID state."
    return
  }
  $rootId = [int]$state.processId
  # /T is deliberately scoped to the one PID whose executable/start time and,
  # when available, command line were validated above. No process name is used.
  $priorErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & taskkill.exe /PID $rootId /T /F 2>$null | Out-Null
    $treeStopExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $priorErrorPreference
  }
  if ($treeStopExitCode -ne 0) { Stop-Process -Id $rootId -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline -and (Get-ProcessRecord $rootId)) { Start-Sleep -Milliseconds 200 }
  if (Get-ProcessRecord $rootId) { throw "LectureAI could not stop its saved $Kind PID $rootId." }
  Remove-Item -LiteralPath (Get-StatePath $Kind) -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped LectureAI $Kind process tree rooted at PID $rootId."
}

function Show-Status {
  $launcher = Get-ValidState 'launcher'
  if ($launcher) { Write-Host "startup: IN PROGRESS (PID $($launcher.processId))" }
  foreach ($kind in @('metro', 'helper')) {
    $state = Get-ValidState $kind
    $healthy = if ($kind -eq 'metro') { Test-MetroHealth } elseif ($state) { Test-HelperHealth ([string]$state.address) } else { $false }
    if ($state) { Write-Host ("{0}: {1} (PID {2})" -f $kind, $(if ($healthy) { 'HEALTHY' } else { 'RUNNING BUT UNHEALTHY' }), $state.processId) }
    else { Write-Host "${kind}: STOPPED" }
  }
  Show-ModelStatus
  Write-Host "Persistent logs: $script:Logs"
}

$mutexNameBytes = [System.Text.Encoding]::UTF8.GetBytes($script:Root.ToLowerInvariant())
$mutexHash = [Convert]::ToBase64String([System.Security.Cryptography.SHA256]::Create().ComputeHash($mutexNameBytes)) -replace '[^A-Za-z0-9]', ''
$mutexSuffix = $mutexHash.Substring(0, 20)

if ($Action -eq 'Status') {
  Show-Status
  exit 0
}

if ($Action -eq 'Launch') {
  $launchMutex = [System.Threading.Mutex]::new($false, "Local\LectureAI-Launch-$mutexSuffix")
  $launchLocked = $false
  try {
    $launchLocked = $launchMutex.WaitOne([TimeSpan]::FromSeconds(10))
    if (-not $launchLocked) { throw 'Another LectureAI launch request is still being prepared. Wait a moment and try again.' }
    Start-DetachedCoordinator $LanAddress | Out-Null
  } finally {
    if ($launchLocked) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
  }
  exit 0
}

if ($Action -eq 'Stop') {
  # Stop an in-progress coordinator first so it cannot start a service after the
  # user has intentionally requested shutdown. Its ownership is validated like
  # every other LectureAI process before taskkill is used.
  Stop-OwnedTree 'launcher'
}

$mutex = [System.Threading.Mutex]::new($false, "Local\LectureAI-$mutexSuffix")
$locked = $false
try {
  $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
  if (-not $locked) { throw 'Another LectureAI launcher is still finishing. Wait a moment and run this again.' }
  switch ($Action) {
    'Start' { Start-Helper $LanAddress | Out-Null; Start-Metro | Out-Null; Show-ModelStatus; Show-QrPage; Show-Status }
    'StartCoordinator' { Start-Helper $LanAddress | Out-Null; Start-Metro | Out-Null; Show-ModelStatus; Show-QrPage; Show-Status }
    'StartMetro' { Start-Metro | Out-Null; Show-QrPage; Show-Status }
    'StartHelper' { Start-Helper $LanAddress | Out-Null; Show-ModelStatus; Show-QrPage -AllowMissingMetro; Show-Status }
    'ShowQr' { Show-QrPage; Show-Status }
    'Stop' {
      Stop-OwnedTree 'helper'
      Stop-OwnedTree 'metro'
      foreach ($temporary in @($script:MetroQrPath, $script:HelperQrPath, $script:QrPagePath, (Join-Path $script:Runtime 'metro-url.txt'))) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      }
      Show-Status
    }
  }
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  if ($Action -eq 'StartCoordinator') { Remove-OwnLauncherState }
}
