# scripts/publish-domain.ps1
#
# Adds a new subdomain to qdrn.io (e.g. md2020.qdrn.io) and routes it through
# the existing Cloudflare Tunnel to the qdrn-radar container in one shot:
#   1. Creates the DNS CNAME record:  <sub>.qdrn.io -> <tunnel-id>.cfargotunnel.com
#   2. Appends an ingress rule to the tunnel config so the hostname forwards
#      to http://qdrn-radar:8080 (path-scoped to /md by default).
# Idempotent — re-running is safe; it skips steps already in place.
#
# Required env vars (set once per shell):
#   $env:CF_API_TOKEN    = Cloudflare API token with permissions:
#                          - Account > Cloudflare Tunnel: Edit
#                          - Zone > DNS: Edit  (scoped to qdrn.io)
#   $env:CF_ACCOUNT_ID   = your Cloudflare account ID (dashboard URL or 'My Profile')
#   $env:CF_ZONE_ID      = the zone ID for qdrn.io (Overview tab of the zone)
#   $env:CF_TUNNEL_ID    = the tunnel UUID (Zero Trust > Networks > Tunnels)
#
# Usage:
#   .\scripts\publish-domain.ps1 md2020
#   .\scripts\publish-domain.ps1 -Sub md2020 -BasePath /md -Service http://qdrn-radar:8080

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)] [string] $Sub,
    [string] $Domain   = 'qdrn.io',
    [string] $BasePath = '/md',
    [string] $Service  = 'http://qdrn-radar:8080'
)

$ErrorActionPreference = 'Stop'

# ----- validate env --------------------------------------------------------
$missing = @()
foreach ($n in 'CF_API_TOKEN','CF_ACCOUNT_ID','CF_ZONE_ID','CF_TUNNEL_ID') {
    if (-not (Get-Item -Path "env:$n" -ErrorAction SilentlyContinue).Value) { $missing += $n }
}
if ($missing.Count -gt 0) {
    Write-Error "Missing env var(s): $($missing -join ', '). See header of this script for what each one is + where to find it."
}

$token     = $env:CF_API_TOKEN
$accountId = $env:CF_ACCOUNT_ID
$zoneId    = $env:CF_ZONE_ID
$tunnelId  = $env:CF_TUNNEL_ID
$fqdn      = "$Sub.$Domain"
$headers   = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

function CFGet  ($url) { Invoke-RestMethod -Uri $url -Method Get  -Headers $headers }
function CFPost ($url, $body) { Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 10 -Compress) }
function CFPut  ($url, $body) { Invoke-RestMethod -Uri $url -Method Put  -Headers $headers -Body ($body | ConvertTo-Json -Depth 10 -Compress) }

Write-Host "→ Publishing $fqdn → $Service$BasePath" -ForegroundColor Cyan

# ----- 1. DNS CNAME -------------------------------------------------------
$dnsList = CFGet "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?name=$fqdn"
if ($dnsList.result.Count -gt 0) {
    Write-Host "  ✓ DNS record for $fqdn already exists (skipping)"
} else {
    $dnsBody = @{
        type    = 'CNAME'
        name    = $Sub
        content = "$tunnelId.cfargotunnel.com"
        proxied = $true
        ttl     = 1
        comment = "qdrn-radar tunnel route (auto-created $(Get-Date -Format 'yyyy-MM-dd'))"
    }
    CFPost "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" $dnsBody | Out-Null
    Write-Host "  ✓ DNS CNAME created: $fqdn → $tunnelId.cfargotunnel.com" -ForegroundColor Green
}

# ----- 2. Tunnel ingress rule --------------------------------------------
$cfgUrl = "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel/$tunnelId/configurations"
$conf   = CFGet $cfgUrl
$ingress = @($conf.result.config.ingress)

# Already routed?
$exists = $ingress | Where-Object { $_.hostname -eq $fqdn -and ($_.path -eq $BasePath -or [string]::IsNullOrEmpty($_.path)) }
if ($exists) {
    Write-Host "  ✓ Tunnel already routes $fqdn → $Service (skipping)"
} else {
    # Cloudflare requires a catch-all (no hostname, no path) as the LAST rule.
    # Insert our new rule right before it so it takes precedence.
    $newRule = @{ hostname = $fqdn; service = $Service }
    if ($BasePath -and $BasePath -ne '/') { $newRule.path = $BasePath }

    $rest    = @($ingress | Where-Object { $_.hostname })
    $fallbck = @($ingress | Where-Object { -not $_.hostname })
    if ($fallbck.Count -eq 0) { $fallbck = @(@{ service = 'http_status:404' }) }

    $newIngress = @() + $rest + $newRule + $fallbck

    # PUT replaces the whole config; carry over warp-routing/origin-request if present.
    $newConfig = @{ ingress = $newIngress }
    if ($conf.result.config.'warp-routing')   { $newConfig.'warp-routing'   = $conf.result.config.'warp-routing' }
    if ($conf.result.config.'origin-request') { $newConfig.'origin-request' = $conf.result.config.'origin-request' }

    CFPut $cfgUrl @{ config = $newConfig } | Out-Null
    Write-Host "  ✓ Tunnel route added: $fqdn → $Service" -ForegroundColor Green
}

Write-Host ""
Write-Host "🚀  https://$fqdn$BasePath/" -ForegroundColor Yellow
Write-Host "    DNS propagates in a few seconds; the tunnel picks up the change immediately."
