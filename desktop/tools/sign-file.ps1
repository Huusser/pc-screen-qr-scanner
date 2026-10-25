param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Pfx = "",
  [string]$Password = "",
  [string]$Thumbprint = "",
  [string]$Timestamp = "",
  [switch]$Dev
)

# Sign one exe with Authenticode.
#
# Only the built-in Set-AuthenticodeSignature cmdlet is used: no Windows SDK
# signtool, no electron-builder winCodeSign package (the latter cannot even be
# extracted on a Windows box without the "create symbolic link" privilege).
#
# Modes:
#   -Pfx / -Password   certificate exported as a .pfx file (software key)
#   -Thumbprint        certificate already installed in CurrentUser\My. This is
#                      the path for OV/EV certificates whose private key lives on
#                      a USB token / HSM and therefore CANNOT be exported to .pfx.
#                      Windows may pop a PIN dialog when the key is used.
#   -Dev               self-signed cert, ONLY to verify the pipeline works.
#                      Nothing trusts it; SmartScreen still blocks.
#
# Timestamping (-Timestamp <url>) is optional but strongly recommended for a
# real release: without it the signature dies together with the certificate
# (usually 1 year), and already-downloaded installers start warning.
#
# This file MUST stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1
# with the ANSI codepage, so non-ASCII bytes can break parsing.

$ErrorActionPreference = "Stop"

# node reads our stdout as UTF-8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Fail($msg) {
  $out = @{ ok = $false; error = $msg }
  Write-Output ($out | ConvertTo-Json -Compress)
  exit 1
}

if (-not (Test-Path -LiteralPath $Path)) { Fail "file not found: $Path" }

$cert = $null

if ($Thumbprint) {
  # Token / HSM certificate: must pick the entry that HAS a private key,
  # otherwise signing cannot work (the key never leaves the device).
  $clean = ($Thumbprint -replace "[^0-9A-Fa-f]", "").ToUpper()
  $cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Thumbprint -eq $clean } |
    Select-Object -First 1
  if (-not $cert) { Fail "certificate not found in CurrentUser\My: $Thumbprint" }
  if (-not $cert.HasPrivateKey) { Fail "certificate has no private key (token not inserted?): $Thumbprint" }
} elseif ($Pfx) {
  if (-not (Test-Path -LiteralPath $Pfx)) { Fail "pfx not found: $Pfx" }
  try {
    $sec = ConvertTo-SecureString -String $Password -AsPlainText -Force
    $cert = Import-PfxCertificate -FilePath $Pfx -CertStoreLocation Cert:\CurrentUser\My -Password $sec -ErrorAction Stop
  } catch {
    Fail ("import pfx failed: " + $_.Exception.Message)
  }
} elseif ($Dev) {
  $subject = "CN=QRScan Dev Self-Signed"
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $subject } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $cert) {
    try {
      $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $subject `
        -CertStoreLocation Cert:\CurrentUser\My `
        -KeyUsage DigitalSignature `
        -NotAfter (Get-Date).AddYears(3) `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") `
        -ErrorAction Stop
    } catch {
      Fail ("create self-signed cert failed: " + $_.Exception.Message)
    }
  }
} else {
  Fail "need -Pfx (production) or -Dev (self-signed test)"
}

$sig = $null
$timed = $false
$timeError = ""

if ($Timestamp) {
  try {
    $sig = Set-AuthenticodeSignature -FilePath $Path -Certificate $cert -TimestampServer $Timestamp -ErrorAction Stop
    $timed = $true
  } catch {
    # A flaky TSA must not block the release: retry without a timestamp and say so.
    $timeError = $_.Exception.Message
    $sig = $null
  }
}
if ($sig -eq $null) {
  try {
    $sig = Set-AuthenticodeSignature -FilePath $Path -Certificate $cert -ErrorAction Stop
  } catch {
    Fail ("sign failed: " + $_.Exception.Message)
  }
}

$out = @{
  # Status alone is not a success criterion: a self-signed certificate yields
  # UnknownError / NotTrusted ("chain terminated in an untrusted root") while
  # the signature bytes are perfectly valid. Judge by whether a signer
  # certificate got embedded, plus the absence of HashMismatch.
  ok            = (($sig.SignerCertificate -ne $null) -and ([string]$sig.Status -ne "HashMismatch"))
  signed        = ($sig.SignerCertificate -ne $null)
  file          = $Path
  status        = [string]$sig.Status
  statusMessage = [string]$sig.StatusMessage
  signer        = [string]$cert.Subject
  thumbprint    = [string]$cert.Thumbprint
  timed         = $timed
  timeError     = $timeError
}
Write-Output ($out | ConvertTo-Json -Compress)

if (($sig.SignerCertificate -eq $null) -or ([string]$sig.Status -eq "HashMismatch")) { exit 1 }
exit 0
