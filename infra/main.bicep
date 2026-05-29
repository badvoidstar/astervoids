targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment (used to generate resource names)')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Name of the container app')
param webServiceName string = ''

@description('Container image tag')
param webImageTag string = ''

@description('Custom domain name for the web app (e.g., yourdomain.com)')
param customDomainName string = ''

@description('Subdomain for the web app (e.g., app)')
param customSubdomain string = ''

@description('Use shared production infrastructure (for CI/CD branch deployments). When false, creates standalone infra.')
param useSharedInfra bool = false

@description('''
Multi-region production deployment manifest. Each entry creates its own
Container Apps Environment + Container App in `rg-production`, plus stamps
the running container with `Region__Id` / `Region__DisplayName` env vars
so the picker can serve the correct manifest.

Entry shape:
  {
    name: 'westus2'              // stable id; used as Region__Id and as the resource-name suffix
    location: 'westus2'          // Azure region (CAE is region-bound)
    displayName: 'US West'       // shown to the user in the picker
  }

When the array is empty (default), the legacy single-region production path
runs — backward-compatible with existing deployments. When the array is
non-empty, the FIRST entry is treated as the "primary" region (it owns the
shared ACR + DNS zone) and any branch deployments target its CAE.

Only applied when isProduction; branch and standalone deployments stay
single-region for cost reasons.
''')
param regions array = []

@description('BYO cert (optional). Full Key Vault secret URL pointing at the wildcard cert that covers <customSubdomain>.<customDomainName> AND all per-region/per-branch subdomains. Required to enable the BYO cert path; when empty, the legacy managed-cert workflow flow is used.')
param certKeyVaultSecretUrl string = ''

@description('BYO cert (optional). Name to give the certificate resource on every CAE that will host this cert. Stable name (typically `wildcard-<sanitised-domain>`) so production multi-region + branch deploys all reference the same identifier.')
param certKeyVaultCertName string = ''

@description('BYO cert (optional). Resource ID of a user-assigned managed identity that has Key Vault Certificate User role on the KV holding the cert. Required when certKeyVaultSecretUrl is set. In production, this can be left empty when manageAcmebotPermissions is true (default) — main.bicep will create id-acme-cert-reader and use its resource ID. Branch deploys MUST set this (via the workflow\'s CERT_READER_IDENTITY_ID GitHub variable) because their bicep run doesn\'t exercise the production path that creates the identity.')
param certReaderIdentityId string = ''

// ─── ACMEbot integration (production only) ─────────────────────────────────
// When true, main.bicep provisions the bits that connect ACMEbot to the
// production deployment:
//   - id-acme-cert-reader user-assigned identity in rg-production
//   - Key Vault Certificate User role on the ACMEbot KV for that identity
//   - DNS Zone Contributor on the production DNS zone for ACMEbot's
//     system-assigned identity (so DNS-01 challenges work)
// Set to false if ACMEbot is not deployed or you're managing these
// permissions outside bicep. Has no effect on non-production deploys.

@description('Whether bicep should provision the ACMEbot integration permissions (cert reader identity, KV role, DNS Zone Contributor). Production-only — ignored for branch and standalone deploys. Default true keeps the documented end-to-end IaC path; set false to opt out and manage manually.')
param manageAcmebotPermissions bool = true

@description('ACMEbot Function App name. Used to look up the system-assigned principal ID for the DNS Zone Contributor role assignment. Default matches the upstream ARM template\'s suggested name.')
param acmebotFunctionAppName string = 'func-astervoids'

@description('Resource group containing the ACMEbot Function App. Default matches the upstream ARM template\'s suggested RG name.')
param acmebotFunctionAppResourceGroup string = 'sg-acmebot'

@description('Name of the Key Vault holding the BYO wildcard cert. Defaults to kv-astervoids (the KV ACMEbot creates by default). Override if your ACMEbot deployment uses a different KV name.')
param acmebotKeyVaultName string = 'kv-astervoids'

@description('Resource group containing the ACMEbot Key Vault. Defaults to sg-acmebot (matches the upstream ARM template). The KV typically lives in the same RG as ACMEbot itself.')
param acmebotKeyVaultResourceGroup string = 'sg-acmebot'

@description('Per-subscription customDomainVerificationId (a 64-char hex string). When set, the multi-region bicep path emits per-region asuid TXT records so Azure accepts the additional custom hostname bindings on each regional container app without "InvalidCustomHostNameValidation" errors. Read from any existing container app via `az containerapp show ... --query properties.customDomainVerificationId -o tsv` — the value is the same across every app in a subscription, so the workflow can pull it from a known-stable app (e.g. ca-web-production) and forward it here. Empty by default — leave unset on greenfield deploys that have no existing apps to read from yet.')
param domainVerificationId string = ''

// Determine deployment path
var isProduction = environmentName == 'production'
var isBranch = !isProduction && useSharedInfra
var isStandalone = !isProduction && !useSharedInfra

// BYO cert enabled iff the two cert params are supplied AND a cert reader
// identity is available — either passed in by the caller, or about to be
// provisioned by the acmebotPermissions module on the production path.
// Resolved against the EFFECTIVE identity rather than the raw param so
// production deploys can omit certReaderIdentityId entirely and still
// enable BYO. Single switch consumed by every container-apps/container-app
// module invocation below so it isn't possible to half-configure.
var byoCertEnabled = !empty(certKeyVaultSecretUrl) && !empty(certKeyVaultCertName) && (!empty(certReaderIdentityId) || (isProduction && manageAcmebotPermissions))

// Multi-region opt-in: production-only and only when the caller passed a
// non-empty regions array. When false, the legacy single-region production
// blocks below execute unchanged.
var isMultiRegion = isProduction && length(regions) > 0
var primaryRegion = isMultiRegion ? regions[0] : { name: '', location: location, displayName: '' }
var sharedInfraPrimaryRegionName = length(regions) > 0 ? regions[0].name : ''

// For branch deployments, use production's shared infrastructure
var sharedResourceGroupName = 'rg-production'

// Resource naming per deployment path
var containerRegistryName = isStandalone
  ? 'cr${environmentName}${uniqueString(subscription().subscriptionId, 'rg-${environmentName}')}'
  : 'crproduction${uniqueString(subscription().subscriptionId, sharedResourceGroupName)}'
// Multi-region: the legacy single CAE is replaced by per-region CAEs named
// cae-production-<regionName>. Branches target the primary region's CAE so
// existing branch deploy flows still find a valid environment.
var containerAppsEnvironmentName = isStandalone
  ? 'cae-${environmentName}'
  : (isProduction
    ? (isMultiRegion ? 'cae-production-${primaryRegion.name}' : 'cae-production')
    : (isBranch && !empty(sharedInfraPrimaryRegionName) ? 'cae-production-${sharedInfraPrimaryRegionName}' : 'cae-production'))

// Determine if custom domain should be configured
var useCustomDomain = !empty(customDomainName) && !empty(customSubdomain)
var fullCustomDomain = useCustomDomain ? '${customSubdomain}.${customDomainName}' : ''
var staticApexEnabled = isMultiRegion && useCustomDomain
var staticApexName = take('swa-${customSubdomain}-${uniqueString(subscription().subscriptionId, customDomainName)}', 40)

// Tags for all resources
var tags = {
  'azd-env-name': environmentName
}

// ============================================================================
// PRODUCTION DEPLOYMENT PATH
// ============================================================================

// Resource group for production
resource productionRg 'Microsoft.Resources/resourceGroups@2022-09-01' = if (isProduction) {
  name: 'rg-production'
  location: location
  tags: tags
}

// ── ACMEbot integration permissions (production + opt-in) ───────────────────
// Provisions id-acme-cert-reader + DNS Zone Contributor + KV Cert User so
// the rest of the BYO cert path "just works" end-to-end without manual
// role assignments. See infra/core/security/acmebot-permissions.bicep for
// the full ownership matrix.
//
// The existing reference to the ACMEbot function app sits OUTSIDE the
// conditional path so its principalId expression has a known shape at
// compile time; the conditional gating happens on the modules themselves
// via the `if (...)` clause.

resource acmebotFunctionApp 'Microsoft.Web/sites@2023-12-01' existing = if (isProduction && manageAcmebotPermissions) {
  name: acmebotFunctionAppName
  scope: resourceGroup(acmebotFunctionAppResourceGroup)
}

#disable-next-line BCP318
module acmebotPermissions 'core/security/acmebot-permissions.bicep' = if (isProduction && manageAcmebotPermissions) {
  name: 'acmebot-permissions'
  scope: productionRg
  params: {
    location: location
    tags: tags
    dnsZoneName: useCustomDomain ? customDomainName : ''
    #disable-next-line BCP318
    acmebotPrincipalId: acmebotFunctionApp.identity.principalId
  }
}

#disable-next-line BCP318
module acmebotKvCertUser 'core/security/kv-cert-user-role.bicep' = if (isProduction && manageAcmebotPermissions) {
  name: 'acmebot-kv-cert-user'
  scope: resourceGroup(acmebotKeyVaultResourceGroup)
  params: {
    keyVaultName: acmebotKeyVaultName
    #disable-next-line BCP318
    principalId: acmebotPermissions.outputs.certReaderPrincipalId
  }
}

// Effective cert reader identity ID consumed by every downstream
// container-apps / container-app module that takes certReaderIdentityId.
// Resolution order (first non-empty wins):
//   1. Caller-supplied `certReaderIdentityId` param (e.g. from the
//      workflow's CERT_READER_IDENTITY_ID GitHub variable) — preserves
//      backward compatibility for non-production deploys.
//   2. The identity bicep just created via acmebotPermissions module
//      (production-only, when manageAcmebotPermissions is true).
//   3. Empty string — BYO cert path stays disabled.
var effectiveCertReaderIdentityId = !empty(certReaderIdentityId)
  ? certReaderIdentityId
  #disable-next-line BCP318
  : ((isProduction && manageAcmebotPermissions) ? acmebotPermissions.outputs.certReaderIdentityId : '')

// ── Single-region production (legacy path; runs when regions array is empty) ──
// Container Apps Environment with Azure Container Registry (production only)
module containerAppsProduction 'core/host/container-apps.bicep' = if (isProduction && !isMultiRegion) {
  name: 'container-apps'
  scope: productionRg
  params: {
    name: containerAppsEnvironmentName
    location: location
    tags: tags
    containerRegistryName: containerRegistryName
    certKeyVaultSecretUrl: certKeyVaultSecretUrl
    certKeyVaultCertName: certKeyVaultCertName
    certReaderIdentityId: effectiveCertReaderIdentityId
  }
}

// Production Container App
module webProduction 'core/host/container-app.bicep' = if (isProduction && !isMultiRegion) {
  name: 'web-production'
  scope: productionRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-production'
    location: location
    tags: union(tags, { 'azd-service-name': 'web' })
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1
    customDomainName: byoCertEnabled && useCustomDomain ? fullCustomDomain : ''
    certificateId: byoCertEnabled ? containerAppsProduction!.outputs.byoCertResourceId : ''
  }
}

// ── Multi-region production (runs when regions array is non-empty) ──
// One Container Apps Environment per region, all sharing a single ACR
// created by the primary region's CAE module (createRegistry=true on index 0,
// false on all others). Region__Id / Region__DisplayName env vars are
// stamped onto each container app so /api/regions answers correctly per region.

@batchSize(1)
module containerAppsRegional 'core/host/container-apps.bicep' = [for (r, i) in (isMultiRegion ? regions : []): {
  name: 'container-apps-${r.name}'
  scope: productionRg
  params: {
    name: 'cae-production-${r.name}'
    location: r.location
    tags: union(tags, { 'astervoids-region': r.name })
    containerRegistryName: containerRegistryName
    // Only the first (primary) region creates the ACR; all subsequent
    // regions reference it via @existing. This avoids creating N registries
    // and keeps image pulls going through a single source of truth.
    createRegistry: i == 0
    // BYO cert: every region's CAE pulls the same wildcard cert from KV
    // so the user-facing custom subdomain has SNI everywhere.
    certKeyVaultSecretUrl: certKeyVaultSecretUrl
    certKeyVaultCertName: certKeyVaultCertName
    certReaderIdentityId: effectiveCertReaderIdentityId
  }
}]

// Per-region computed values (multi-region + BYO custom domain only).
// Builds two derived collections used by the modules below:
//
//   regionsManifest: stamped onto every container app's env vars as
//     Region__Regions__N__{Id,DisplayName,Hostname} so the /api/regions
//     endpoint returns the canonical peer list. Hostname is the BYO
//     per-region URL (covered by the wildcard cert).
//
//   perRegionCnames: extra CNAME records in the DNS zone, one per region,
//     pointing each per-region subdomain at the corresponding container
//     app's azurecontainerapps.io FQDN. Resolved at deploy time from
//     webRegional outputs.
var manifestRegions = (isMultiRegion && useCustomDomain) ? regions : []
var regionsManifest = [for r in manifestRegions: {
  id: r.name
  displayName: r.?displayName ?? r.name
  hostname: 'https://${customSubdomain}-${r.name}.${customDomainName}'
}]

// Per-region CNAME records emitted BEFORE the regional container apps so
// custom hostname ownership validation succeeds when each app binds its
// per-region subdomain. We construct the predictable app FQDN
// (<app-name>.<cae-default-domain>) from the CAE's defaultDomain output
// without needing the app to exist yet, breaking the chicken-and-egg
// (app needs CNAME to bind; CNAME needs app FQDN to target).
//
// Without this pre-creation, Azure rejects the app's customDomains
// binding with InvalidCustomHostNameValidation ("A TXT record pointing
// from asuid.<subdomain> to <verificationId> was not found").
#disable-next-line BCP318
module dnsRecordsPerRegion 'core/dns/dns-extra-cnames.bicep' = if (isMultiRegion && useCustomDomain) {
  name: 'dns-records-per-region'
  scope: productionRg
  params: {
    dnsZoneName: customDomainName
    domainVerificationId: domainVerificationId
    cnames: [for (r, i) in manifestRegions: {
      name: '${customSubdomain}-${r.name}'
      #disable-next-line BCP318
      target: 'ca-web-production-${r.name}.${containerAppsRegional[i].outputs.defaultDomain}'
    }]
  }
  dependsOn: [dnsZone, containerAppsRegional]
}

@batchSize(1)
module webRegional 'core/host/container-app.bicep' = [for (r, i) in (isMultiRegion ? regions : []): {
  name: 'web-production-${r.name}'
  scope: productionRg
  params: {
    name: 'ca-web-production-${r.name}'
    location: r.location
    // Each region's container app is its own azd service so `azd deploy`
    // (and CI's per-region update step) target the right resource.
    tags: union(tags, { 'azd-service-name': 'web-${r.name}', 'astervoids-region': r.name })
    containerAppsEnvironmentName: 'cae-production-${r.name}'
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1
    // BYO cert binds per-region custom domain on every regional app:
    //   - additionalCustomDomain (= per-region subdomain, e.g.
    //     asteroids-westus2.example.com): unique per region, used by
    //     the picker to measure RTT and open SignalR connections to a
    //     specific region. Wildcard cert covers both. Ownership validated
    //     via the CNAME emitted by dnsRecordsPerRegion above.
    // The apex custom domain is now served by the Static Web App entrypoint.
    // When BYO is not configured, this stays empty and the workflow's
    // legacy managed-cert flow runs per-region instead.
    customDomainName: ''
    additionalCustomDomain: byoCertEnabled && useCustomDomain ? '${customSubdomain}-${r.name}.${customDomainName}' : ''
    #disable-next-line BCP318
    certificateId: byoCertEnabled ? containerAppsRegional[i].outputs.byoCertResourceId : ''
    regionId: r.name
    regionDisplayName: r.?displayName ?? r.name
    // Every region ships the SAME manifest so the client can fetch
    // /api/regions from any landing region and get the full peer list.
    regionsManifest: regionsManifest
    // Visitors land on the static apex first and then issue cross-origin
    // requests to per-region hostnames — apex MUST be in CORS allowed-
    // origins or the picker stalls in "warming" and Create fails.
    apexHostname: useCustomDomain ? 'https://${fullCustomDomain}' : ''
  }
  // dependsOn dnsRecordsPerRegion so the per-region CNAMEs exist before
  // Azure validates the additionalCustomDomain binding on this app.
  dependsOn: [containerAppsRegional, dnsRecordsPerRegion]
}]

// DNS Zone for custom domain (production only)
module dnsZone 'core/dns/dns-zone.bicep' = if (isProduction && useCustomDomain) {
  name: 'dns-zone'
  scope: productionRg
  params: {
    domainName: customDomainName
    tags: tags
  }
}

// DNS records for production custom domain (single-region only; multi-region
// custom-domain DNS is emitted by `dnsRecordsProductionMultiRegion` below).
// When BYO cert is enabled, the asuid TXT record is omitted (no managed-cert
// validation is performed) — only the CNAME is required for traffic routing.
module dnsRecordsProduction 'core/dns/dns-records.bicep' = if (isProduction && !isMultiRegion && useCustomDomain) {
  name: 'dns-records-production'
  scope: productionRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: webProduction!.outputs.fqdn
    verificationToken: byoCertEnabled ? '' : webProduction!.outputs.verificationId
  }
  dependsOn: [dnsZone]
}

// ── Static apex entrypoint (multi-region production + custom domain) ──────────
// Instead of apex -> Traffic Manager, apex now points at a Static Web App.
// The browser stays on the apex URL while the picker routes API/SignalR
// calls directly to per-region hostnames.
module staticApex 'core/host/static-web-app.bicep' = if (staticApexEnabled) {
  name: 'static-apex'
  scope: productionRg
  params: {
    name: staticApexName
    location: location
    tags: tags
  }
}

// DNS records for production custom domain (multi-region static-apex path).
// CNAMEs the user's custom subdomain to the Static Web App default hostname.
// asuid TXT is skipped because this hostname is not bound on ACA.
module dnsRecordsProductionMultiRegion 'core/dns/dns-records.bicep' = if (staticApexEnabled) {
  name: 'dns-records-production-multi'
  scope: productionRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    #disable-next-line BCP318
    targetHostname: staticApex!.outputs.defaultHostname
    skipAsuid: true
  }
  dependsOn: [dnsZone]
}

// ============================================================================
// STANDALONE DEPLOYMENT PATH (local dev via azd up)
// ============================================================================

// Resource group for standalone deployments
resource standaloneRg 'Microsoft.Resources/resourceGroups@2022-09-01' = if (isStandalone) {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

// Container Apps Environment with Azure Container Registry (standalone).
// Standalone is local dev — it can opt into BYO cert by passing the same
// params (rare), but typically isn't used with a custom domain.
module containerAppsStandalone 'core/host/container-apps.bicep' = if (isStandalone) {
  name: 'container-apps-standalone'
  scope: standaloneRg
  params: {
    name: containerAppsEnvironmentName
    location: location
    tags: tags
    containerRegistryName: containerRegistryName
    certKeyVaultSecretUrl: certKeyVaultSecretUrl
    certKeyVaultCertName: certKeyVaultCertName
    certReaderIdentityId: effectiveCertReaderIdentityId
  }
}

// Standalone Container App
module webStandalone 'core/host/container-app.bicep' = if (isStandalone) {
  name: 'web-standalone'
  scope: standaloneRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-${environmentName}'
    location: location
    tags: union(tags, { 'azd-service-name': 'web' })
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1
    customDomainName: byoCertEnabled && useCustomDomain ? fullCustomDomain : ''
    certificateId: byoCertEnabled ? containerAppsStandalone!.outputs.byoCertResourceId : ''
  }
}

// ============================================================================
// BRANCH DEPLOYMENT PATH (CI/CD, uses shared production infra)
// ============================================================================

// Reference to existing production resource group for branch deployments
resource sharedRg 'Microsoft.Resources/resourceGroups@2022-09-01' existing = if (isBranch) {
  name: sharedResourceGroupName
}

resource branchContainerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-10-02-preview' existing = if (isBranch) {
  name: containerAppsEnvironmentName
  scope: sharedRg
}

var branchContainerAppName = !empty(webServiceName) ? webServiceName : 'ca-web-${environmentName}'

// Branch cert resource ID. When BYO is enabled, branches bind their custom
// hostname to the SAME wildcard cert that production uses, parented on the
// shared CAE. The cert is materialised by:
//   - the workflow's "Bootstrap BYO cert on shared CAE" step BEFORE this
//     bicep runs (idempotently attaches the cert-reader identity to the
//     existing CAE and creates the cert resource if missing), OR
//   - a prior production deploy (bicep already created both via its
//     containerAppsProduction / containerAppsRegional modules).
// Either way, by the time this expression is evaluated the cert exists
// and we just reference it by its known resource ID.
var branchCertResourceId = (isBranch && byoCertEnabled)
  ? '/subscriptions/${subscription().subscriptionId}/resourceGroups/${sharedResourceGroupName}/providers/Microsoft.App/managedEnvironments/${containerAppsEnvironmentName}/certificates/${certKeyVaultCertName}'
  : ''

// For BYO branch deploys, emit DNS records BEFORE creating the app so custom
// hostname validation succeeds at app-create time.
module dnsRecordsBranchByo 'core/dns/dns-records.bicep' = if (isBranch && useCustomDomain && byoCertEnabled) {
  // Truncated for the same BCP335 reason as webBranch above.
  name: take('dns-records-byo-${environmentName}', 64)
  scope: sharedRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    #disable-next-line BCP318
    targetHostname: '${branchContainerAppName}.${branchContainerAppsEnvironment!.properties.defaultDomain}'
    verificationToken: domainVerificationId
    skipAsuid: false
  }
}

// Branch Container App (uses existing shared infrastructure).
// When BYO cert is enabled, branches bind their per-branch subdomain
// (e.g. astervoids-mybranch.<domain>) to the shared wildcard cert with
// SniEnabled — no managed-cert provisioning, ~5 min saved per deploy.
// When BYO is NOT enabled, branches fall back to the legacy managed-cert
// flow via the workflow's Configure Custom Domain step.
module webBranch 'core/host/container-app.bicep' = if (isBranch) {
  // Module deployment name is just a human-readable label in ARM; truncating
  // environmentName here (capped at 64 chars by @maxLength) is sufficient
  // headroom for the 'web-' prefix without exceeding the 64-char module
  // name limit (BCP335).
  name: take('web-${environmentName}', 64)
  scope: sharedRg
  params: {
    name: branchContainerAppName
    location: location
    tags: union(tags, { 'azd-service-name': 'web-${environmentName}' })  // Unique tag per branch
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1  // Limit branch deployments
    customDomainName: useCustomDomain ? fullCustomDomain : ''
    certificateId: branchCertResourceId
  }
  dependsOn: [dnsRecordsBranchByo]
}

// DNS records for branch custom domain (uses existing DNS zone in production RG).
// Non-BYO path: emit the asuid TXT with the branch container app's
// verificationId so the legacy managed-cert flow can validate ownership.
module dnsRecordsBranch 'core/dns/dns-records.bicep' = if (isBranch && useCustomDomain && !byoCertEnabled) {
  // Truncated for the same BCP335 reason as webBranch above (12-char prefix +
  // up-to-64-char environmentName would exceed the module name limit).
  name: take('dns-records-${environmentName}', 64)
  scope: sharedRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: webBranch!.outputs.fqdn
    verificationToken: webBranch!.outputs.verificationId
    skipAsuid: false
  }
}

// ============================================================================
// OUTPUTS
// ============================================================================

// Common web app output expressions (DRY: each conditional module output is referenced once).
// In multi-region production, the "primary" deployment is index 0 of the regions
// array — that's what azd / CI tooling reports as the canonical WEB_URI.
// Each conditional module's `.outputs.x` is null-asserted with `!` because the
// ternary structure already ensures we only read the branch that was deployed.
var webUri = isProduction
  ? (isMultiRegion
    ? (staticApexEnabled ? 'https://${fullCustomDomain}' : webRegional[0]!.outputs.uri)
    : webProduction!.outputs.uri)
  : (isStandalone ? webStandalone!.outputs.uri : webBranch!.outputs.uri)
var webName = isProduction
  ? (isMultiRegion ? webRegional[0]!.outputs.name : webProduction!.outputs.name)
  : (isStandalone ? webStandalone!.outputs.name : webBranch!.outputs.name)
var webVerificationId = isProduction
  ? (isMultiRegion ? webRegional[0]!.outputs.verificationId : webProduction!.outputs.verificationId)
  : (isStandalone ? webStandalone!.outputs.verificationId : webBranch!.outputs.verificationId)

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = isProduction
  ? (isMultiRegion ? containerAppsRegional[0]!.outputs.registryLoginServer : containerAppsProduction!.outputs.registryLoginServer)
  : (isStandalone ? containerAppsStandalone!.outputs.registryLoginServer : '${containerRegistryName}.azurecr.io')
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistryName
output WEB_URI string = webUri
output WEB_AZURE_URI string = webUri
output DNS_NAME_SERVERS array = (isProduction && useCustomDomain) ? dnsZone!.outputs.nameServers : []
output CONTAINER_APP_NAME string = webName
output CONTAINER_APPS_ENVIRONMENT string = containerAppsEnvironmentName
output RESOURCE_GROUP string = isProduction ? 'rg-production' : (isStandalone ? 'rg-${environmentName}' : sharedResourceGroupName)
output CUSTOM_DOMAIN string = fullCustomDomain
output DOMAIN_VERIFICATION_ID string = webVerificationId

// Effective cert reader identity resource ID actually consumed by container-apps modules.
// In production with manageAcmebotPermissions=true, this is the bicep-created
// id-acme-cert-reader; otherwise it echoes the caller-supplied param. Empty
// string when BYO is not configured. Useful for the workflow to assert that
// the identity it expects to use is the one bicep is wiring up, and for the
// branch-deploy bootstrap step to discover the ID without needing the
// CERT_READER_IDENTITY_ID GitHub variable.
@description('Resource ID of the user-assigned managed identity used to pull the BYO cert from Key Vault. Empty when BYO is not configured.')
output CERT_READER_IDENTITY_ID string = effectiveCertReaderIdentityId

// Multi-region outputs: one entry per region with everything CI/CD needs to
// push an image and configure DNS. Empty array in single-region mode so
// downstream tooling can detect "is this a multi-region deploy?" by checking
// `length(REGION_ENDPOINTS) > 0`.
#disable-next-line BCP318
output REGION_ENDPOINTS array = [for (r, i) in (isMultiRegion ? regions : []): {
  id: r.name
  displayName: r.?displayName ?? r.name
  location: r.location
  containerAppName: webRegional[i].outputs.name
  fqdn: webRegional[i].outputs.fqdn
  uri: webRegional[i].outputs.uri
  verificationId: webRegional[i].outputs.verificationId
}]

@description('FQDN of the Static Web App default hostname used by the production multi-region apex CNAME. Empty string when not using the static-apex path.')
#disable-next-line BCP318
output STATIC_WEB_APP_DEFAULT_HOSTNAME string = staticApexEnabled ? staticApex.outputs.defaultHostname : ''

@description('Static Web App resource name for production multi-region apex hosting. Empty string when not using the static-apex path.')
#disable-next-line BCP318
output STATIC_WEB_APP_NAME string = staticApexEnabled ? staticApex.outputs.name : ''

@description('Canonical region manifest for static-apex clients. Each entry uses the per-region custom-domain hostname.')
output STATIC_APEX_REGION_MANIFEST array = regionsManifest

@description('Legacy output retained for backward compatibility. Empty string on static-apex path.')
output TRAFFIC_MANAGER_FQDN string = ''
