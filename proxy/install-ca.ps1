param(
    [Parameter(Mandatory = $true)][string]$CerPath,
    [switch]$Remove,
    [switch]$Verify
)

$ErrorActionPreference = "Stop"

try {
    if (-not (Test-Path $CerPath)) {
        Write-Output "MISSING"
        exit 1
    }

    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CerPath)

    # Verify: read-only probe, no writes. run_proxy.py calls this right after
    # install because "the script printed OK" does not prove the entry survived
    # (some security software rolls Root-store writes back silently).
    # Output is machine-checked, so keep the words stable: OK PRESENT / ABSENT.
    if ($Verify) {
        $vstore = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
        $vstore.Open("ReadOnly")
        $present = $false
        foreach ($vc in $vstore.Certificates) {
            if ($vc.Thumbprint -eq $cert.Thumbprint) { $present = $true }
        }
        $vstore.Close()
        if ($present) { Write-Output "OK PRESENT" } else { Write-Output "ABSENT" }
        exit 0
    }

    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
    $store.Open("ReadWrite")

    $found = $false
    foreach ($c in $store.Certificates) {
        if ($c.Thumbprint -eq $cert.Thumbprint) { $found = $true }
    }

    if ($Remove) {
        if ($found) {
            $store.Remove($cert)
            Write-Output "OK REMOVED"
        } else {
            Write-Output "OK NOTFOUND"
        }
    } else {
        if ($found) {
            Write-Output "OK ALREADY"
        } else {
            $store.Add($cert)
            Write-Output "OK INSTALLED"
        }
    }

    $store.Close()
} catch {
    Write-Output ("FAIL " + $_.Exception.Message)
    exit 1
}
