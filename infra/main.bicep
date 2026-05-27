targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment (used to generate resource names)')
param environmentName string

@minLength(1)
@description('Primary location for all resources. When the `regions` parameter is non-empty in production, the primary region from that list takes precedence.')
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

@description('When true (production only), deploy Azure Front Door for static-only HTTP routing. Only static SPA assets are routed through Front Door; realtime and probe endpoints (/sessionHub, /api/ping) must stay on direct regional endpoints for reliability and protocol correctness.')
param enableFrontDoorStaticOnly bool = false

@description('Regional deployment plan. Each element: { id, location, displayName, minReplicas?, maxReplicas?, isPrimary? }. Exactly one entry should set isPrimary:true (its location overrides the top-level `location` param for the primary RG). minReplicas: 0 cold-starts on first traffic, while hot primary regions can set minReplicas: 1. An empty array falls back to a single-region deployment at the `location` param.')
param regions array = []

// Determine deployment path
var isProduction = environmentName == 'production'
var isBranch = !isProduction && useSharedInfra
var isStandalone = !isProduction && !useSharedInfra

// For branch deployments, use production's shared infrastructure
var sharedResourceGroupName = 'rg-production'

// ── Regional deployment plan resolution ───────────────────────────────
// Primary region: explicit `isPrimary: true` entry, else first entry, else a synthetic
// entry derived from the `location` param (single-region back-compat).
var primaryFromFlag = filter(regions, r => contains(r, 'isPrimary') && bool(r.isPrimary))
var primaryRegion = length(primaryFromFlag) > 0
  ? primaryFromFlag[0]
  : (length(regions) > 0
      ? regions[0]
      : { id: 'primary', location: location, displayName: 'Primary', minReplicas: 0, maxReplicas: 3, isPrimary: true })
var primaryLocation = contains(primaryRegion, 'location') ? string(primaryRegion.location) : location
var primaryMinReplicas = contains(primaryRegion, 'minReplicas') ? int(primaryRegion.minReplicas) : 0
var primaryMaxReplicas = contains(primaryRegion, 'maxReplicas') ? int(primaryRegion.maxReplicas) : 3

// Secondary regions: every entry that is not the primary (only deployed in the production path).
var secondaryRegions = filter(regions, r => !(contains(r, 'isPrimary') && bool(r.isPrimary)))
// Only produce secondaries if a primary was explicitly tagged; otherwise the first entry is the
// primary (back-compat) and everything else is treated as secondary. Gate on isProduction so
// for-loops over this variable produce empty arrays in non-production deployments.
var rawSecondaryRegions = length(primaryFromFlag) > 0
  ? secondaryRegions
  : (length(regions) > 1 ? skip(regions, 1) : [])
var effectiveSecondaryRegions = isProduction ? rawSecondaryRegions : []

// Resource naming per deployment path
var containerRegistryName = isStandalone
  ? 'cr${environmentName}${uniqueString(subscription().subscriptionId, 'rg-${environmentName}')}'
  : 'crproduction${uniqueString(subscription().subscriptionId, sharedResourceGroupName)}'
var containerAppsEnvironmentName = isStandalone ? 'cae-${environmentName}' : 'cae-production'

// Determine if custom domain should be configured
var useCustomDomain = !empty(customDomainName) && !empty(customSubdomain)
var fullCustomDomain = useCustomDomain ? '${customSubdomain}.${customDomainName}' : ''
var staticRoutePatterns = [
  '/'
  '/index.html'
  '/ops.html'
  '/favicon.ico'
  '/manifest.json'
  '/robots.txt'
  '/js/*'
  '/css/*'
  '/img/*'
  '/audio/*'
  '/fonts/*'
  '/debug/*'
]

// Tags for all resources
var tags = {
  'azd-env-name': environmentName
}

// ============================================================================
// PRODUCTION DEPLOYMENT PATH — primary region (westus2 by default)
// ============================================================================

// Resource group for production primary region
resource productionRg 'Microsoft.Resources/resourceGroups@2022-09-01' = if (isProduction) {
  name: 'rg-production'
  location: primaryLocation
  tags: tags
}

// Container Apps Environment with Azure Container Registry (production primary)
module containerAppsProduction 'core/host/container-apps.bicep' = if (isProduction) {
  name: 'container-apps'
  scope: productionRg
  params: {
    name: containerAppsEnvironmentName
    location: primaryLocation
    tags: tags
    containerRegistryName: containerRegistryName
  }
}

// Production Container App (primary region)
module webProduction 'core/host/container-app.bicep' = if (isProduction) {
  name: 'web-production'
  scope: productionRg
  params: {
    name: !empty(webServiceName) ? webServiceName : 'ca-web-production'
    location: primaryLocation
    tags: union(tags, { 'azd-service-name': 'web' })
    containerAppsEnvironmentName: containerAppsEnvironmentName
    containerRegistryName: containerRegistryName
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: primaryMinReplicas
    maxReplicas: primaryMaxReplicas
    customDomainName: ''
  }
  dependsOn: [containerAppsProduction]
}

// DNS Zone for custom domain (production only)
module dnsZone 'core/dns/dns-zone.bicep' = if (isProduction && useCustomDomain) {
  name: 'dns-zone'
  scope: productionRg
  params: {
    domainName: customDomainName
    tags: tags
  }
}

// ============================================================================
// PRODUCTION STATIC FRONT DOOR (optional, static-only split enforcement)
// ============================================================================
// Why the split:
// - Front Door gives one global entrypoint for cacheable SPA/static bytes.
// - SignalR/WebSocket paths (/sessionHub) and latency probes (/api/ping) are kept
//   off Front Door to avoid introducing extra hops, websocket/proxy caveats, and
//   operational ambiguity during region failover or incident response.
// - Clients must target direct regional endpoints for realtime/control-plane traffic.
// Caveat: static route patterns below must stay explicit. Do NOT broaden to '/api/*'
// or '/sessionHub*', or realtime traffic will be fronted accidentally.
module staticFrontDoor 'core/network/frontdoor-static-only.bicep' = if (isProduction && enableFrontDoorStaticOnly) {
  name: 'frontdoor-static-only'
  scope: productionRg
  params: {
    profileName: 'afd-static-${uniqueString(subscription().subscriptionId, environmentName)}'
    originHostName: webProduction.outputs.fqdn
    staticRoutePatterns: staticRoutePatterns
    customDomainHostName: useCustomDomain ? fullCustomDomain : ''
    tags: tags
  }
  dependsOn: [webProduction]
}

// DNS target for the single custom domain:
// - Front Door endpoint when static split is enabled
// - direct primary region container app otherwise
var customDomainTargetHostname = (isProduction && enableFrontDoorStaticOnly)
  ? staticFrontDoor.outputs.endpointHostName
  : webProduction.outputs.fqdn

// DNS records for production custom domain
module dnsRecordsProduction 'core/dns/dns-records.bicep' = if (isProduction && useCustomDomain) {
  name: 'dns-records-production'
  scope: productionRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: customDomainTargetHostname
    verificationToken: webProduction.outputs.verificationId
  }
  dependsOn: [dnsZone]
}

// ============================================================================
// PRODUCTION DEPLOYMENT PATH — secondary regions (e.g. northeurope for Dublin)
// ============================================================================
// Each secondary region gets its own resource group, Container Apps Environment, and
// Container App. The container apps pull from the primary region's ACR (cross-region pulls
// are fine at low volume; geo-replication can be layered on later if needed).
// Sibling Regions__All__* env vars are injected post-provision by the CI/CD workflow
// once every region's auto-generated FQDN is known.

resource secondaryRgs 'Microsoft.Resources/resourceGroups@2022-09-01' = [for region in effectiveSecondaryRegions: if (isProduction) {
  name: 'rg-production-${region.id}'
  location: region.location
  tags: tags
}]

module containerAppsSecondary 'core/host/container-apps-env.bicep' = [for (region, i) in effectiveSecondaryRegions: if (isProduction) {
  name: 'container-apps-${region.id}'
  scope: resourceGroup('rg-production-${region.id}')
  params: {
    name: 'cae-production-${region.id}'
    location: region.location
    tags: tags
  }
  dependsOn: [secondaryRgs]
}]

module webSecondary 'core/host/container-app.bicep' = [for (region, i) in effectiveSecondaryRegions: if (isProduction) {
  name: 'web-production-${region.id}'
  scope: resourceGroup('rg-production-${region.id}')
  params: {
    name: 'ca-web-production-${region.id}'
    location: region.location
    tags: union(tags, { 'azd-service-name': 'web-${region.id}' })
    containerAppsEnvironmentName: 'cae-production-${region.id}'
    containerRegistryName: containerRegistryName
    containerRegistryResourceGroup: 'rg-production'
    imageName: !empty(webImageTag) ? 'astervoids-web:${webImageTag}' : ''
    targetPort: 8080
    external: true
    minReplicas: contains(region, 'minReplicas') ? int(region.minReplicas) : 0
    maxReplicas: contains(region, 'maxReplicas') ? int(region.maxReplicas) : 3
    customDomainName: ''
  }
  dependsOn: [containerAppsSecondary, webProduction]
}]

// ============================================================================
// STANDALONE DEPLOYMENT PATH (local dev via azd up)
// ============================================================================

// Resource group for standalone deployments
resource standaloneRg 'Microsoft.Resources/resourceGroups@2022-09-01' = if (isStandalone) {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

// Container Apps Environment with Azure Container Registry (standalone)
module containerAppsStandalone 'core/host/container-apps.bicep' = if (isStandalone) {
  name: 'container-apps-standalone'
  scope: standaloneRg
  params: {
    name: containerAppsEnvironmentName
    location: location
    tags: tags
    containerRegistryName: containerRegistryName
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
    minReplicas: primaryMinReplicas
    maxReplicas: primaryMaxReplicas
    customDomainName: ''
  }
  dependsOn: [containerAppsStandalone]
}

// ============================================================================
// BRANCH DEPLOYMENT PATH (CI/CD, uses shared production infra)
// ============================================================================
// Branch previews are single-region (primary) only — keeps PR previews cheap and fast.

// Reference to existing production resource group for branch deployments
resource sharedRg 'Microsoft.Resources/resourceGroups@2022-09-01' existing = if (isBranch) {
  name: sharedResourceGroupName
}

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
    minReplicas: primaryMinReplicas
    maxReplicas: primaryMaxReplicas
    customDomainName: ''
  }
}

// DNS records for branch custom domain (uses existing DNS zone in production RG)
module dnsRecordsBranch 'core/dns/dns-records.bicep' = if (isBranch && useCustomDomain) {
  name: 'dns-records-${environmentName}'
  scope: sharedRg
  params: {
    dnsZoneName: customDomainName
    subdomain: customSubdomain
    targetHostname: webBranch.outputs.fqdn
    verificationToken: webBranch.outputs.verificationId
  }
}

// ============================================================================
// OUTPUTS
// ============================================================================

// Common web app output expressions (DRY: each conditional module output is referenced once)
var webUri = isProduction ? webProduction.outputs.uri : (isStandalone ? webStandalone.outputs.uri : webBranch.outputs.uri)
var webName = isProduction ? webProduction.outputs.name : (isStandalone ? webStandalone.outputs.name : webBranch.outputs.name)
var webVerificationId = isProduction ? webProduction.outputs.verificationId : (isStandalone ? webStandalone.outputs.verificationId : webBranch.outputs.verificationId)

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = isProduction ? containerAppsProduction.outputs.registryLoginServer : (isStandalone ? containerAppsStandalone.outputs.registryLoginServer : '${containerRegistryName}.azurecr.io')
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

// Per-region outputs (primary + secondaries). Workflow uses these to fan out image deploys
// and inject Regions__* env vars on every region's container app.
output PRIMARY_REGION_ID string = isProduction ? primaryRegion.id : ''
output PRIMARY_WEB_URI string = isProduction ? webProduction.outputs.uri : ''
output PRIMARY_CONTAINER_APP_NAME string = isProduction ? webProduction.outputs.name : ''
output PRIMARY_RESOURCE_GROUP string = isProduction ? 'rg-production' : ''

output SECONDARY_REGION_IDS array = [for region in effectiveSecondaryRegions: region.id]
#disable-next-line BCP318
output SECONDARY_WEB_URIS array = [for (region, i) in effectiveSecondaryRegions: webSecondary[i].outputs.uri]
#disable-next-line BCP318
output SECONDARY_CONTAINER_APP_NAMES array = [for (region, i) in effectiveSecondaryRegions: webSecondary[i].outputs.name]
output SECONDARY_RESOURCE_GROUPS array = [for region in effectiveSecondaryRegions: 'rg-production-${region.id}']
output FRONT_DOOR_STATIC_ENDPOINT string = (isProduction && enableFrontDoorStaticOnly) ? 'https://${staticFrontDoor.outputs.endpointHostName}' : ''
