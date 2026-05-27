@description('Name of the DNS zone')
param dnsZoneName string

@description('Subdomain name (e.g., "astervoids" for astervoids.domain.com)')
param subdomain string

@description('Target hostname for the CNAME record')
param targetHostname string

@description('Single Container App customDomainVerificationId. Use when binding the custom hostname to ONE container app with managed-cert CNAME/HTTP validation (single-region path). Ignored when verificationTokens is non-empty. Empty/empty: no asuid TXT record is emitted (used when BYO cert is configured — no managed-cert validation needed).')
param verificationToken string = ''

@description('Multi-region path: array of customDomainVerificationId values, one per region whose container app needs to serve this hostname. Emits a multi-value asuid.<subdomain> TXT record so every region can independently validate its own managed cert against the shared hostname. When empty AND verificationToken is empty, no asuid TXT record is emitted.')
param verificationTokens array = []

@description('When true, never emit the asuid TXT record regardless of verificationToken(s). Used by the BYO cert path: bicep binds the cert from Key Vault directly, so no managed-cert ownership validation runs and the TXT would just be dead weight.')
param skipAsuid bool = false

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
// validation. Azure DNS supports multi-value TXT records — we emit one
// value per region's customDomainVerificationId so every region's managed
// cert validation succeeds when it queries asuid.<subdomain>. Falls back
// to a single-value record when verificationTokens is empty (single-region
// path). Skipped entirely when both are empty (BYO cert path — no managed
// cert validation is performed so no asuid record is needed).
var effectiveTokens = !empty(verificationTokens) ? verificationTokens : (empty(verificationToken) ? [] : [verificationToken])
var emitAsuid = !skipAsuid && !empty(effectiveTokens)

resource txtRecord 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (emitAsuid) {
  parent: dnsZone
  name: 'asuid.${subdomain}'
  properties: {
    TTL: 3600
    TXTRecords: [for token in effectiveTokens: {
      value: [token]
    }]
  }
}

output fqdn string = '${subdomain}.${dnsZoneName}'
