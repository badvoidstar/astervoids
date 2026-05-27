// =============================================================================
// Azure Traffic Manager profile providing DNS-level performance routing across
// multi-region Container Apps deployments. The apex hostname
// (e.g. `astervoids.<domain>`) CNAMEs to the profile FQDN; Traffic Manager
// returns the IP of the nearest healthy regional Container App for each
// visitor's first DNS lookup.
//
// The apex is ONLY used as a landing optimisation. Once the client has loaded
// `region-service.js`, it measures RTT to every region directly via
// `/api/ping` on each region's per-region hostname and pins SignalR
// connections to its measured-best region. Traffic Manager doesn't need to be
// "perfect" — it just needs to give first-time visitors a near-correct
// starting point.
//
// ## Why performance routing (not weighted / priority)
//
// - Performance: routes to the region with lowest measured network latency
//   from the requesting DNS resolver. This is the closest analogue to what the
//   client itself does post-load, so the apex stays consistent with the
//   picker's `bestRegion()` choice.
// - Weighted would require manual rebalancing per region; Priority would
//   always pin to one region until it fails. Neither matches "show every user
//   their nearest region by default".
//
// ## Why probe `/api/regions` instead of `/api/ping`
//
// `/api/regions` is just as cheap (returns a small JSON document, no service
// work) but it's an endpoint we already need for the picker bootstrap, so we
// get free production traffic into it. More importantly, the probe interval
// (default 30 s, raised to 60 s here) acts as a floor on how often regions
// can scale to zero — if probes were too frequent they would defeat the
// scale-to-zero requirement. 60 s probes leave a 60 s window where a region
// can be fully cold; combined with the Container App `cooldownPeriod: 60s`
// that means a truly idle region can scale to zero between probes.
// =============================================================================

@description('Name of the Traffic Manager profile (must be globally unique within trafficmanager.net).')
param name string

@description('DNS relative name (a.k.a. profile FQDN prefix). Result FQDN: <relativeName>.trafficmanager.net. Defaults to `name` for simplicity.')
param relativeName string = name

@description('Tags applied to the profile resource.')
param tags object = {}

// Endpoints to register on the profile. Each entry should look like:
//   {
//     name: 'westus2'                                  // unique within profile; we use the region id
//     target: 'ca-web-production-westus2.kindbeach...' // container app FQDN (NO https:// prefix)
//     endpointLocation: 'westus2'                      // required by Performance routing — Azure region of the target
//   }
@description('Endpoints to register on the profile (one per region; see file header for entry shape).')
param endpoints array

@description('Probe interval in seconds. Default 60 — higher than the Traffic Manager default of 30 specifically so probes do NOT keep idle regions warm and defeat the scale-to-zero requirement.')
param probeIntervalInSeconds int = 60

@description('Number of consecutive failed probes before an endpoint is marked Degraded. Default 3 (Azure default).')
param toleratedNumberOfFailures int = 3

@description('Probe timeout in seconds. Default 9 (max allowed when intervalInSeconds is 60, per Azure docs: timeoutInSeconds must be < intervalInSeconds and ≤ 10).')
param timeoutInSeconds int = 9

@description('TTL (seconds) returned by Traffic Manager DNS responses. Low values respond to topology changes faster; higher values reduce DNS query load on Azure. 60s is the Azure default.')
param ttl int = 60

@description('Health probe path on each endpoint. Defaults to `/api/regions` — see module description for rationale.')
param probePath string = '/api/regions'

@description('Health probe port. 443 because every endpoint is HTTPS-only (matches container app ingress configuration).')
param probePort int = 443

// Traffic Manager is a global Azure resource — its `location: 'global'` is required.
resource profile 'Microsoft.Network/trafficmanagerprofiles@2022-04-01' = {
  name: name
  location: 'global'
  tags: tags
  properties: {
    profileStatus: 'Enabled'
    trafficRoutingMethod: 'Performance'
    dnsConfig: {
      relativeName: relativeName
      ttl: ttl
    }
    monitorConfig: {
      protocol: 'HTTPS'
      port: probePort
      path: probePath
      intervalInSeconds: probeIntervalInSeconds
      timeoutInSeconds: timeoutInSeconds
      toleratedNumberOfFailures: toleratedNumberOfFailures
    }
    // Endpoints are declared as nested children below; this property is
    // also populated server-side once children are created.
    endpoints: []
  }
}

// One ExternalEndpoint per region. We use ExternalEndpoints (not
// AzureEndpoints) because Container Apps' Microsoft.App/containerApps
// resource type isn't natively supported as an AzureEndpoint target; the
// public FQDN works perfectly through the External path with minimal
// configuration.
resource regionEndpoints 'Microsoft.Network/trafficmanagerprofiles/externalEndpoints@2022-04-01' = [for ep in endpoints: {
  parent: profile
  name: ep.name
  properties: {
    endpointStatus: 'Enabled'
    target: ep.target
    // Required for Performance routing — Traffic Manager uses this to
    // compute distance from the requesting DNS resolver to each endpoint.
    endpointLocation: ep.endpointLocation
    priority: 1
    weight: 1
  }
}]

@description('FQDN of the Traffic Manager profile (e.g. astervoids.trafficmanager.net). CNAME the apex domain to this hostname.')
output fqdn string = profile.properties.dnsConfig.fqdn

@description('Resource id of the profile (useful for diagnostics / alert rule wiring).')
output profileId string = profile.id

@description('Endpoint ids in the order the input `endpoints` array was provided. Lets the caller correlate provisioned endpoints back to its regions array.')
output endpointIds array = [for (ep, i) in endpoints: regionEndpoints[i].id]
