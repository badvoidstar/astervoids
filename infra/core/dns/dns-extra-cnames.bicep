// Emits a list of CNAME records in an existing DNS zone. Used to pre-create
// per-region subdomain CNAMEs (e.g. `asteroids-westus2.example.com` →
// `ca-web-production-westus2.<unique>.westus2.azurecontainerapps.io`) BEFORE
// the container apps that will bind those hostnames are deployed.
//
// Why this exists separately from `dns-records.bicep`:
//   `dns-records.bicep` unconditionally emits a CNAME for its `subdomain`
//   parameter, so you can't reuse it just for the "additional" records
//   without re-emitting the apex (which collides with the apex → Traffic
//   Manager CNAME emitted later by `dns-records.bicep` itself).
//
// Why pre-creation matters:
//   Azure rejects a container app's `customDomains[]` binding with
//   `InvalidCustomHostNameValidation` if the bound hostname has no
//   ownership evidence — i.e. no existing CNAME pointing at the app's
//   FQDN and no `asuid.<subdomain>` TXT record with the app's
//   verificationId. Pre-creating the CNAME (using the predictable
//   `<app-name>.<cae-default-domain>` FQDN) satisfies the CNAME path
//   without needing the app to exist first.

@description('Name of the DNS zone (must already exist in the same RG as this module).')
param dnsZoneName string

@description('List of CNAME records to emit. Each entry: { name: "asteroids-westus2", target: "ca-web-production-westus2.<unique>.westus2.azurecontainerapps.io" }. Empty list = no records emitted (module is effectively a no-op).')
param cnames array

@description('TTL (seconds) for the emitted CNAMEs. 3600 (1 hour) matches the apex record default and is short enough that a deploy-time mis-target gets corrected within an hour.')
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
