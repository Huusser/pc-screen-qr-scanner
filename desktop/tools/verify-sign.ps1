param(
  [Parameter(Mandatory = $true)][string]$Path
)

# Read back the Authenticode state of a file. Pure reporting, changes nothing.
# Same output shape as sign-file.ps1 so callers can share the parser.

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Output (@{ ok = $false; file = $Path; error = "file not found" } | ConvertTo-Json -Compress)
  exit 1
}

$sig = Get-AuthenticodeSignature -FilePath $Path

# Signature is "present" when a signer certificate got embedded.
$signed = ($sig.SignerCertificate -ne $null)

# A self-signed / private-root signer is a valid signature with an untrusted
# chain. Surface that as its own state so the caller does not mistake it for a
# failure (or for a properly trusted release).
$trusted = ([string]$sig.Status -eq "Valid")

$ts = $null
if ($sig.TimeStamperCertificate -ne $null) {
  $ts = @{
    subject = [string]$sig.TimeStamperCertificate.Subject
    notAfter = $sig.TimeStamperCertificate.NotAfter.ToString("yyyy-MM-dd")
  }
}

$out = @{
  ok            = $signed
  file          = $Path
  signed        = $signed
  trusted       = $trusted
  status        = [string]$sig.Status
  statusMessage = [string]$sig.StatusMessage
  signer        = if ($signed) { [string]$sig.SignerCertificate.Subject } else { "" }
  notAfter      = if ($signed) { $sig.SignerCertificate.NotAfter.ToString("yyyy-MM-dd") } else { "" }
  timestamped   = ($ts -ne $null)
  timestamp     = $ts
}
Write-Output ($out | ConvertTo-Json -Compress -Depth 4)

if ($signed) { exit 0 } else { exit 1 }
