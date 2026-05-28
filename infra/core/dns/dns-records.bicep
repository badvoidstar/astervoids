@description('Name of the DNS zone')
param dnsZoneName string

@description('Subdomain name (e.g., "astervoids" for astervoids.domain.com)')
param subdomain string

@description('Target hostname for the CNAME record')
param targetHostname string

@description('Single Container App customDomainVerificationId for managed-cert CNAME/HTTP validation (single-region path). Empty when BYO cert path is used (asuid TXT not emitted).')
param verificationToken string = ''

@description('When true, never emit the asuid TXT record regardless of verificationToken. Used by the BYO cert path: bicep binds the cert from Key Vault directly, so no managed-cert ownership validation runs and the TXT would just be dead weight.')
param skipAsuid bool = false

@description('Optional list of additional per-region CNAME records to create in the same zone alongside the main subdomain. Each entry: { name: "asteroids-westus2", target: "ca-web-production-westus2.<unique>.westus2.azurecontainerapps.io" }. Used by multi-region production so the picker can target individual regions directly while the main subdomain (asteroids.<domain>) CNAMEs to Traffic Manager. TTL is shared with the main record. Empty by default — no records emitted.')
param additionalCnames array = []

// Reference existing DNS zone
resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: dnsZoneName
}

// CNAME record for the subdomain — points to either a single container app
// FQDN (single-region) or the Traffic Manager profile FQDN (multi-region).
// Both shapes are handled identically here; the caller decides which
// targetHostname to pass.
resource cnameRecord 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: dnsZone
  name: subdomain
  properties: {
    TTL: 3600
    CNAMERecord: {
      cname: targetHostname
    }
  }
}

// asuid.<subdomain> TXT record for Container Apps managed-certificate
// validation. Emitted only when (a) we have a verificationToken AND
// (b) skipAsuid is false. In the multi-region BYO-cert path this is
// always skipped — bicep binds the cert from KV directly so no
// managed-cert ownership validation runs.
var emitAsuid = !skipAsuid && !empty(verificationToken)

resource txtRecord 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (emitAsuid) {
  parent: dnsZone
  name: 'asuid.${subdomain}'
  properties: {
    TTL: 3600
    TXTRecords: [
      { value: [verificationToken] }
    ]
  }
}

// Additional per-region CNAME records (multi-region only). Each one is a
// separate subdomain in the same zone — e.g. asteroids-westus2.bootyblocks.com
// → ca-web-production-westus2.<unique>.westus2.azurecontainerapps.io. Covered
// by the wildcard cert bound on the corresponding regional container app.
resource additionalCnameRecords 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = [for cname in additionalCnames: {
  parent: dnsZone
  name: cname.name
  properties: {
    TTL: 3600
    CNAMERecord: {
      cname: cname.target
    }
  }
}]

output fqdn string = '${subdomain}.${dnsZoneName}'
