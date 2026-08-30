<#
    tools/install.ps1 — deploy MediaRade into the CEP extensions folder.
    MediaRade by sgtsilicon

        npm run build
        npm run deploy          (or: powershell -File tools\install.ps1)

    Copies only what the panel needs — CSXS\, dist\, jsx\ and .debug — so the
    installed folder mirrors the repo and re-deploying is just a re-copy.
    Close Premiere first; it reads the manifest once at startup.
#>
[CmdletBinding()]
param(
    [string] $BundleId = 'org.rad1x.mediarade',
    [switch] $Symlink          # develop against the repo instead of copying
)

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dst = Join-Path $ext $BundleId

if (-not (Test-Path (Join-Path $src 'dist\js\mediarade.js'))) {
    throw "dist\js\mediarade.js is missing. Run 'npm run build' first."
}

if (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) {
    Write-Warning 'Premiere Pro is running. It will not pick up manifest changes until you restart it.'
}

New-Item -ItemType Directory -Force $ext | Out-Null

if ($Symlink) {
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -Confirm:$false }
    New-Item -ItemType SymbolicLink -Path $dst -Target $src | Out-Null
    Write-Host "linked  $dst -> $src" -ForegroundColor Green
} else {
    New-Item -ItemType Directory -Force $dst | Out-Null

    # clear any older flattened layout so a stale index.html cannot win
    foreach ($stale in @('index.html', 'css', 'js')) {
        $p = Join-Path $dst $stale
        if (Test-Path $p) { Remove-Item $p -Recurse -Force -Confirm:$false }
    }

    foreach ($item in @('CSXS', 'dist', 'jsx', '.debug')) {
        $s = Join-Path $src $item
        $d = Join-Path $dst $item
        if (Test-Path $d) { Remove-Item $d -Recurse -Force -Confirm:$false }
        Copy-Item $s $d -Recurse -Force
        Write-Host "copied  $item"
    }

    # the Chrome-driven Uppbeat login helper (zero-dependency .mjs, run by the
    # system Node, so it lives outside the vite bundle)
    $toolDir = Join-Path $dst 'tools'
    New-Item -ItemType Directory -Force $toolDir | Out-Null
    Copy-Item (Join-Path $src 'tools\uppbeat-login.mjs') (Join-Path $toolDir 'uppbeat-login.mjs') -Force
    Write-Host 'copied  tools\uppbeat-login.mjs'
    Write-Host "installed to $dst" -ForegroundColor Green
}

# unsigned extensions need debug mode on the CSXS version Premiere uses
$missing = @()
foreach ($v in 9..13) {
    $k = "HKCU:\Software\Adobe\CSXS.$v"
    if (Test-Path $k) {
        $mode = (Get-ItemProperty $k -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
        if ($mode -ne '1') { $missing += $v }
    }
}
if ($missing.Count) {
    Write-Warning "PlayerDebugMode is not enabled for CSXS $($missing -join ', '). Unsigned extensions will not load. Enable it with:"
    foreach ($v in $missing) {
        Write-Host "  reg add HKCU\Software\Adobe\CSXS.$v /v PlayerDebugMode /t REG_SZ /d 1 /f" -ForegroundColor Yellow
    }
} else {
    Write-Host 'PlayerDebugMode: enabled' -ForegroundColor Green
}

Write-Host 'Open Premiere Pro, then Window > Extensions > MediaRade.'
