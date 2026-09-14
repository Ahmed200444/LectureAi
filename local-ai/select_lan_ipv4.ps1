# Emits only machine-readable "IPv4|Adapter name" rows. It intentionally uses
# Windows networking cmdlets, never localized ipconfig output.
$ErrorActionPreference = 'Stop'
$virtual = 'Loopback|vEthernet|Hyper-V|VMware|VirtualBox|Tailscale|WireGuard|OpenVPN|VPN|Docker|WSL|NdisWan|TAP|ZeroTier'
$normal = 'Wi-?Fi|Wireless|Ethernet|802\.3'
$private = '^(?:192\.168\.(?:\d{1,3})\.(?:\d{1,3})|10\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3})\.(?:\d{1,3}))$'

$candidates = foreach ($adapter in Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' }) {
  $label = "$($adapter.Name) $($adapter.InterfaceDescription)"
  if ($label -match $virtual) { continue }
  $config = Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue
  if (-not $config) { continue }
  $metric = (Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).InterfaceMetric
  foreach ($entry in @($config.IPv4Address)) {
    $ip = [string]$entry.IPAddress
    if ($ip -notmatch $private -or $ip -like '169.254.*') { continue }
    [pscustomobject]@{
      IP = $ip
      Name = [string]$adapter.Name
      IsNormal = [bool]($label -match $normal)
      HasGateway = [bool]$config.IPv4DefaultGateway
      Metric = if ($null -ne $metric) { [int]$metric } else { 9999 }
    }
  }
}

# If normal Wi-Fi/Ethernet is present, virtual/fallback adapters never compete.
if ($candidates | Where-Object IsNormal) { $candidates = $candidates | Where-Object IsNormal }
# A default gateway is a strong signal of the LAN used by the phone.
if ($candidates | Where-Object HasGateway) { $candidates = $candidates | Where-Object HasGateway }

$candidates | Sort-Object Metric, Name, IP | ForEach-Object {
  # Keep the exact output contract safe for cmd.exe capture.
  '{0}|{1}' -f $_.IP, ($_.Name -replace '[\r\n|]', ' ')
}
