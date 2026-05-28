// Emits a list of CNAME records — and optionally matching `asuid.<subdomain>`
// TXT records — in an existing DNS zone. Used to pre-create per-region
// hostname records BEFORE the container apps that will bind those
// hostnames are deployed.
//
// Why this exists separately from `dns-records.bicep`:
//   `dns-records.bicep` unconditionally emits a CNAME for its `subdomain`
//   parameter, so you can't reuse it just for the "additional" records
//   without re-emitting the apex CNAME (which would collide with the apex
//   record emitted elsewhere in the deployment path).
//
// Why pre-creation matters:
//   Azure rejects a container app's `customDomains[]` binding with
//   `InvalidCustomHostNameValidation` ("A TXT record pointing from
//   asuid.<subdomain> to <verificationId> was not found") if the bound
//   hostname has no ownership evidence at the moment ARM validates.
//   Despite the docs claiming CNAME validation works for container apps,
//   in practice — when bicep adds a NEW customDomains entry to an
//   EXISTING app — only the asuid TXT path consistently succeeds.
//
//   `customDomainVerificationId` is per-subscription (NOT per-app), so a
//   single value is reused for every per-region TXT here. Caller passes
//   it via `domainVerificationId`; when empty the TXT records are
//   skipped (CNAME-only mode, which works for some greenfield cases but
//   not for hostname additions on existing apps).

@description('Name of the DNS zone (must already exist in the same RG as this module).')
param dnsZoneName string

@description('List of CNAME records to emit. Each entry: { name: "asteroids-westus2", target: "ca-web-production-westus2.<unique>.westus2.azurecontainerapps.io" }. Empty list = no records emitted (module is effectively a no-op).')
param cnames array

@description('Per-subscription customDomainVerificationId. When non-empty, an asuid.<name> TXT record is emitted alongside each CNAME so Azure accepts the hostname binding when bicep adds it to an existing app. When empty, no TXT records are emitted (CNAME-only).')
param domainVerificationId string = ''

@description('TTL (seconds) for the emitted records. 3600 (1 hour) matches the apex record default and is short enough that a deploy-time mis-target gets corrected within an hour.')
param ttl int = 3600

resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: dnsZoneName
}

resource cnameRecords 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = [for cname in cnames: {
  parent: dnsZone
  name: cname.name
  properties: {
    TTL: ttl
    CNAMERecord: {
      cname: cname.target
    }
  }
}]

resource asuidTxtRecords 'Microsoft.Network/dnsZones/TXT@2018-05-01' = [for cname in (empty(domainVerificationId) ? [] : cnames): {
  parent: dnsZone
  name: 'asuid.${cname.name}'
  properties: {
    TTL: ttl
    TXTRecords: [
      { value: [domainVerificationId] }
    ]
  }
}]
