# Installs gz from GitHub Releases on Windows (design-agent-access.md Q39).
#   irm https://gazetta.studio/install/gz.ps1 | iex
# $env:GZ_VERSION picks a version (default: latest); $env:GZ_INSTALL_DIR the
# folder (default: $env:LOCALAPPDATA\gz).
$ErrorActionPreference = 'Stop'

$repo = 'gazetta-studio/gazetta-studio'
$dir = if ($env:GZ_INSTALL_DIR) { $env:GZ_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'gz' }
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { throw "gz: unsupported processor $($env:PROCESSOR_ARCHITECTURE)" }
}

$version = $env:GZ_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name.TrimStart('v')
}

$archive = "gz_${version}_windows_${arch}.zip"
$base = "https://github.com/$repo/releases/download/v$version"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Invoke-WebRequest "$base/$archive" -OutFile (Join-Path $tmp $archive)
  Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')
  $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { $_ -match " $([regex]::Escape($archive))$" }
  if (-not $line) { throw "gz: no checksum for $archive" }
  $expected = ($line -split ' ')[0]
  $actual = (Get-FileHash (Join-Path $tmp $archive) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "gz: checksum mismatch for $archive" }

  Expand-Archive (Join-Path $tmp $archive) -DestinationPath $tmp
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item (Join-Path $tmp 'gz.exe'), (Join-Path $tmp 'gazetta-cli.exe') -Destination $dir -Force
  Write-Host "Installed gz $version in $dir"
  if (-not ($env:Path -split ';' -contains $dir)) { Write-Host "Add $dir to your PATH to run gz." }
} finally {
  Remove-Item -Recurse -Force $tmp
}
