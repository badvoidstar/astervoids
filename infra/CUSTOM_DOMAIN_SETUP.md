# Custom Domain HTTPS Setup

## Overview
Custom domain configuration for Azure Container Apps requires DNS verification to be in place before the domain can be added. The deployment handles this in two phases:

1. **Phase 1 (Automated)**: Deploy the app without custom domain, create DNS zone and verification records
2. **Phase 2 (Automated with retry)**: Add custom domain and enable HTTPS after DNS propagates

## Prerequisites: GitHub Secrets

To enable custom domain support, you must configure these GitHub Secrets:

| Secret | Example Value | Description |
|--------|---------------|-------------|
| `CUSTOM_DOMAIN_NAME` | `yourdomain.com` | Your root domain name |
| `CUSTOM_SUBDOMAIN` | `app` | Subdomain for the application |

If these secrets are not set, the deployment will succeed but skip custom domain configuration entirely.

**To add secrets:** Go to your repo → Settings → Secrets and variables → Actions → New repository secret

## How It Works

### Initial Deployment
When you deploy to the `production` environment with secrets configured, the workflow:
1. Creates the Container App (without custom domain)
2. Creates the Azure DNS Zone for your domain
3. Creates DNS records:
   - CNAME record: `<subdomain>.<yourdomain.com>` → Container App FQDN
   - TXT record: `asuid.<subdomain>.<yourdomain.com>` → Domain verification ID

### Custom Domain Setup
After the base deployment, the workflow attempts to:
1. Add the custom hostname to the Container App
2. Create a managed SSL certificate
3. Bind the certificate to enable HTTPS

**Note**: This step uses `continue-on-error: true` because DNS propagation may not be complete on the first deployment. Subsequent deployments will succeed once DNS has propagated.

## DNS Configuration

### If Using Azure DNS (Recommended)
The deployment automatically creates the DNS zone and records. You need to configure your domain registrar to use Azure's name servers:

```
ns1-XX.azure-dns.com
ns2-XX.azure-dns.net
ns3-XX.azure-dns.org
ns4-XX.azure-dns.info
```

The name servers are output after deployment as `DNS_NAME_SERVERS`.

### If Using External DNS
If your domain is hosted elsewhere, you need to manually create:

1. **CNAME Record**:
   - Name: `<your-subdomain>` (e.g., `app`)
   - Value: `<container-app-fqdn>` (e.g., `ca-web-production.redfield-xxxxx.eastus.azurecontainerapps.io`)

2. **TXT Record** (for domain verification):
   - Name: `asuid.<your-subdomain>` (e.g., `asuid.app`)
   - Value: The `DOMAIN_VERIFICATION_ID` from deployment output

## Manual Custom Domain Setup

If the automated setup fails (e.g., DNS not propagated yet), run manually:

```powershell
# From the repository root
.\infra\enable-custom-domain.ps1 `
    -ResourceGroup "rg-production" `
    -ContainerAppName "ca-web-production" `
    -EnvironmentName "cae-production" `
    -CustomDomain "app.yourdomain.com"
```

Or using Azure CLI:

```bash
# 1. Add hostname
az containerapp hostname add \
    --resource-group rg-production \
    --name ca-web-production \
    --hostname app.yourdomain.com

# 2. Create certificate
az containerapp env certificate create \
    --resource-group rg-production \
    --name cae-production \
    --certificate-name cert-app-yourdomain-com \
    --hostname app.yourdomain.com \
    --validation-method CNAME

# 3. Bind certificate
az containerapp hostname bind \
    --resource-group rg-production \
    --name ca-web-production \
    --hostname app.yourdomain.com \
    --environment cae-production \
    --validation-method CNAME
```

## Regional Custom-Domain Routing Analysis (Pre/Post Phase 3/4)

### 1) Does one custom domain work for all users in multi-region?
- **Pre-Phase 3/4 (single-region)**: Yes. One custom domain maps to one Container App, and all HTTP + SignalR traffic lands in that region.
- **Post-Phase 3/4 (multi-region)**: A single custom domain still resolves to **one** regional origin unless a global routing layer is added. Users in other geographies can still connect, but they connect to that mapped region, not automatically to their nearest region.

### 2) What default traffic patterns are enabled/restricted?
- **HTTP app traffic + `/sessionHub` SignalR** follow the same host origin. With default custom-domain setup, both terminate in the single mapped region.
- In regional builds, discovery may show sessions from multiple regions, but join/create calls still execute against the region behind the currently connected host.
- With **N regions**, single-host routing creates an asymmetry: one region is directly reachable by custom domain while others are only reachable by their region FQDN (unless a global entry layer is added).

### 3) What can break or confuse users if only one region is fronted?
- Higher RTT for far-away users (all game + hub traffic hairpins to the mapped region).
- Session discovery/join mismatch risk in regional mode (remote sessions may be visible, but joining through the wrong regional host can fail or feel inconsistent).
- Operational confusion: operators may think “multi-region is on” while the user-facing custom domain effectively behaves single-region.
- Cold-start/availability concentration: if the mapped region is degraded, the custom domain path is degraded even if sibling regions are healthy.

### 4) If custom domain is moved to another region FQDN, what changes?
- New and returning users land in the newly mapped region for session creation/join over `/sessionHub`.
- Region-latency UX and probe outputs shift to the new anchor region.
- Existing users/bookmarks to old regional FQDNs still work, but mixed links can fragment where sessions are created and joined.

### 5) Caveats for Front Door, `/sessionHub`, and `/api/ping`
- **Bicep note cross-reference**: see `infra/main.bicep` regional routing caveat comment near `fullCustomDomain` and `useCustomDomain`.
- Keep `/sessionHub` and `/api/ping` region-pinned to regional origins.
- Do **not** front these paths with a global route that can silently move a client between regions across calls.
  - `/sessionHub`: connection affinity and region-local session ownership assumptions can break.
  - `/api/ping`: probe RTT becomes synthetic to edge pathing, not true region RTT.

### 6) Recommended next steps for seamless single-domain multi-region
1. Keep one global “entry” hostname (Front Door or equivalent) for static/app shell and region selection UX.
2. Publish explicit per-region public origins for region-sensitive paths.
3. Route/pin `/sessionHub` and `/api/ping` directly to chosen regional origin (or use deterministic, sticky routing keyed per user/session).
4. Make region intent explicit in session lifecycle (create/join should either redirect or fail with clear region guidance).
5. Add ops monitors for cross-region discovery/join consistency and per-region probe health.

## Ops Checklist (Single- and Multi-Region)

- [ ] Custom domain CNAME points to expected target origin (single region or global entry).
- [ ] `asuid.<subdomain>` TXT verification exists and matches deployment output.
- [ ] HTTPS cert is present and bound for the custom hostname.
- [ ] `/sessionHub` reaches the intended regional backend (no unintended global re-homing).
- [ ] `/api/ping` (regional mode) is measured per-region, not edge-short-circuited.
- [ ] Session discovery and join behavior are validated from at least two geographies.
- [ ] If multiple region FQDNs are exposed, UX copy clarifies region selection and expected latency.
- [ ] Failover runbook defines how/when to swap custom domain target and how to communicate expected session-impact.

## Troubleshooting

### "TXT record not found" Error
This means DNS verification records haven't propagated yet. Solutions:
- Wait 5-15 minutes and re-run the deployment
- Verify DNS records are correctly configured at your registrar
- Check if you're using Azure DNS name servers

### Check DNS Propagation
```bash
# Check TXT record (replace with your domain)
nslookup -type=TXT asuid.app.yourdomain.com

# Check CNAME record  
nslookup app.yourdomain.com
```

### View Current Configuration
```bash
# List hostnames on container app
az containerapp hostname list \
    --resource-group rg-production \
    --name ca-web-production

# List certificates in environment
az containerapp env certificate list \
    --resource-group rg-production \
    --name cae-production
```
