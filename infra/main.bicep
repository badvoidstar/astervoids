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

@description('BYO cert (optional). Resource ID of a user-assigned managed identity that has Key Vault Certificate User role on the KV holding the cert. Required when certKeyVaultSecretUrl is set.')
param certReaderIdentityId string = ''

// Determine deployment path
var isProduction = environmentName == 'production'
var isBranch = !isProduction && useSharedInfra
var isStandalone = !isProduction && !useSharedInfra

// BYO cert enabled iff all 3 params are supplied. Single switch consumed by
// every container-apps/container-app module invocation below so it isn't
// possible to half-configure (e.g. cert on the CAE but no identity).
var byoCertEnabled = !empty(certKeyVaultSecretUrl) && !empty(certKeyVaultCertName) && !empty(certReaderIdentityId)

// Multi-region opt-in: production-only and only when the caller passed a
// non-empty regions array. When false, the legacy single-region production
// blocks below execute unchanged.
var isMultiRegion = isProduction && length(regions) > 0
var primaryRegion = isMultiRegion ? regions[0] : { name: '', location: location, displayName: '' }

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
  : (isMultiRegion ? 'cae-production-${primaryRegion.name}' : 'cae-production')

// Determine if custom domain should be configured
var useCustomDomain = !empty(customDomainName) && !empty(customSubdomain)
var fullCustomDomain = useCustomDomain ? '${customSubdomain}.${customDomainName}' : ''

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
    certReaderIdentityId: certReaderIdentityId
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
    #disable-next-line BCP318
    certificateId: byoCertEnabled ? containerAppsProduction.outputs.byoCertResourceId : ''
  }
  dependsOn: [containerAppsProduction]
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
    certReaderIdentityId: certReaderIdentityId
  }
}]

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
    // BYO cert: every region's container app binds the SAME wildcard
    // hostname using its CAE's cert resource. When BYO is not configured,
    // customDomainName is empty so the workflow's legacy managed-cert flow
    // runs per-region instead (with TXT/CNAME validation as appropriate).
    customDomainName: byoCertEnabled && useCustomDomain ? fullCustomDomain : ''
    #disable-next-line BCP318
    certificateId: byoCertEnabled ? containerAppsRegional[i].outputs.byoCertResourceId : ''
    regionId: r.name
    regionDisplayName: r.?displayName ?? r.name
  }
  dependsOn: [containerAppsRegional]
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
    targetHostname: webProduction.outputs.fqdn
    verificationToken: byoCertEnabled ? '' : webProduction.outputs.verificationId
  }
  dependsOn: [dnsZone]
}

// ── Traffic Manager apex routing (multi-region production only) ──────────────
// Profile FQDN: <profileName>.trafficmanager.net. The apex custom domain (if
// configured) CNAMEs to this profile so a first-time visitor hits their nearest
// region. After load, the client takes over via per-region hostnames.
//
// `relativeName` must be globally unique within trafficmanager.net — using a
// uniqueString suffix keyed on the subscription + 'astervoids' avoids
// collisions when multiple subscriptions deploy the same template.
var trafficManagerRelativeName = 'astervoids-${uniqueString(subscription().subscriptionId, 'astervoids-tm')}'

#disable-next-line BCP318
module trafficManager 'core/network/traffic-manager.bicep' = if (isMultiRegion) {
  name: 'traffic-manager'
  scope: productionRg
  params: {
    name: trafficManagerRelativeName
    relativeName: trafficManagerRelativeName
    tags: tags
    endpoints: [for (r, i) in (isMultiRegion ? regions : []): {
      name: r.name
      target: webRegional[i].outputs.fqdn
      endpointLocation: r.location
    }]
  }
  dependsOn: [webRegional]
}

// DNS records for production custom domain (multi-region path).
// CNAMEs the user's custom subdomain to the Traffic Manager FQDN so a
// browser visiting `<customSubdomain>.<customDomainName>` is DNS-routed to
// the nearest healthy region. Multi-region custom domain ALWAYS uses BYO
// cert (ACA managed certs can't validate behind an intermediate CNAME like
// Traffic Manager — the workflow's fail-fast guard rejects multi-region +
// custom domain without BYO cert before bicep ever runs). Therefore the
// asuid TXT record is always skipped here: bicep binds the cert from KV
// directly, no managed-cert ownership validation runs.
#disable-next-line BCP318
module dnsRecordsProductionMultiRegion 'core/dns/dns-records.bicep' = if (isMultiRegion && useCustomDomain) {
  name: 'dns-records-production-multi'
  scope: productionRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: trafficManager.outputs.fqdn
    skipAsuid: true
  }
  dependsOn: [dnsZone, trafficManager]
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
    certReaderIdentityId: certReaderIdentityId
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
    #disable-next-line BCP318
    certificateId: byoCertEnabled ? containerAppsStandalone.outputs.byoCertResourceId : ''
  }
  dependsOn: [containerAppsStandalone]
}

// ============================================================================
// BRANCH DEPLOYMENT PATH (CI/CD, uses shared production infra)
// ============================================================================

// Reference to existing production resource group for branch deployments
resource sharedRg 'Microsoft.Resources/resourceGroups@2022-09-01' existing = if (isBranch) {
  name: sharedResourceGroupName
}

// Branch BYO cert — ensures the wildcard cert exists on the shared
// production CAE BEFORE webBranch tries to bind its hostname to it.
// Idempotent: production's own deploy creates the same resource with
// identical properties; whichever deploys first wins, and subsequent
// invocations are no-ops. Without this module, a branch deploy that
// runs before production has been redeployed with BYO config (e.g. the
// first time a developer enables CERT_KEY_VAULT_* vars) would fail with
// "CertificateNotFound" because the cert simply doesn't exist on
// cae-production yet.
#disable-next-line BCP318
module branchByoCert 'core/host/byo-cert.bicep' = if (isBranch && byoCertEnabled) {
  name: 'byo-cert-branch-${environmentName}'
  scope: sharedRg
  params: {
    environmentName: containerAppsEnvironmentName
    name: certKeyVaultCertName
    keyVaultUrl: certKeyVaultSecretUrl
    identityResourceId: certReaderIdentityId
    tags: union(tags, { 'azd-env-name': 'production' })
  }
}

// Branch cert resource ID. The cert is materialised by branchByoCert above
// (when BYO is enabled) — we reference its output so bicep dependency
// resolution guarantees the cert exists before the container app tries
// to bind to it. When BYO is disabled, the empty string falls through to
// the legacy bindingType=Disabled flow in container-app.bicep.
#disable-next-line BCP318
var branchCertResourceId = (isBranch && byoCertEnabled) ? branchByoCert.outputs.certificateResourceId : ''

// Branch Container App (uses existing shared infrastructure)
module webBranch 'core/host/container-app.bicep' = if (isBranch) {
  name: 'web-${environmentName}'
  scope: sharedRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-${environmentName}'
    location: location
    tags: union(tags, { 'azd-service-name': 'web-${environmentName}' })  // Unique tag per branch
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: 0
    maxReplicas: 1  // Limit branch deployments
    customDomainName: byoCertEnabled && useCustomDomain ? fullCustomDomain : ''
    certificateId: branchCertResourceId
  }
}

// DNS records for branch custom domain (uses existing DNS zone in production RG).
// Same BYO-cert short-circuit as production: skip asuid TXT when bicep is
// binding the cert directly from KV.
module dnsRecordsBranch 'core/dns/dns-records.bicep' = if (isBranch && useCustomDomain) {
  name: 'dns-records-${environmentName}'
  scope: sharedRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: webBranch.outputs.fqdn
    verificationToken: byoCertEnabled ? '' : webBranch.outputs.verificationId
  }
}

// ============================================================================
// OUTPUTS
// ============================================================================

// Common web app output expressions (DRY: each conditional module output is referenced once).
// In multi-region production, the "primary" deployment is index 0 of the regions
// array — that's what azd / CI tooling reports as the canonical WEB_URI.
#disable-next-line BCP318
var webUri = isProduction
  ? (isMultiRegion ? webRegional[0].outputs.uri : webProduction.outputs.uri)
  : (isStandalone ? webStandalone.outputs.uri : webBranch.outputs.uri)
#disable-next-line BCP318
var webName = isProduction
  ? (isMultiRegion ? webRegional[0].outputs.name : webProduction.outputs.name)
  : (isStandalone ? webStandalone.outputs.name : webBranch.outputs.name)
#disable-next-line BCP318
var webVerificationId = isProduction
  ? (isMultiRegion ? webRegional[0].outputs.verificationId : webProduction.outputs.verificationId)
  : (isStandalone ? webStandalone.outputs.verificationId : webBranch.outputs.verificationId)

#disable-next-line BCP318
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = isProduction
  ? (isMultiRegion ? containerAppsRegional[0].outputs.registryLoginServer : containerAppsProduction.outputs.registryLoginServer)
  : (isStandalone ? containerAppsStandalone.outputs.registryLoginServer : '${containerRegistryName}.azurecr.io')
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistryName
output WEB_URI string = webUri
output WEB_AZURE_URI string = webUri
#disable-next-line BCP318
output DNS_NAME_SERVERS array = (isProduction && useCustomDomain) ? dnsZone.outputs.nameServers : []
output CONTAINER_APP_NAME string = webName
output CONTAINER_APPS_ENVIRONMENT string = containerAppsEnvironmentName
output RESOURCE_GROUP string = isProduction ? 'rg-production' : (isStandalone ? 'rg-${environmentName}' : sharedResourceGroupName)
output CUSTOM_DOMAIN string = fullCustomDomain
output DOMAIN_VERIFICATION_ID string = webVerificationId

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

@description('FQDN of the multi-region Traffic Manager profile (CNAME the apex domain here). Empty string when single-region.')
#disable-next-line BCP318
output TRAFFIC_MANAGER_FQDN string = isMultiRegion ? trafficManager.outputs.fqdn : ''
