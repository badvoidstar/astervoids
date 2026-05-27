// ACMEbot integration permissions for the production resource group.
//
// What this module owns:
//   1. `id-acme-cert-reader` — user-assigned managed identity that Container
//      Apps uses to pull the BYO wildcard cert from Key Vault (referenced by
//      every CAE that hosts the cert via certificateKeyVaultProperties.identity).
//   2. DNS Zone Contributor role assignment on the production DNS zone for
//      ACMEbot's system-assigned identity. ACMEbot needs this so the
//      Let's Encrypt DNS-01 challenge can write/remove the temporary
//      _acme-challenge TXT record on the zone.
//
// What lives elsewhere:
//   - The Key Vault Certificate User role assignment on the BYO cert KV is
//     in `kv-cert-user-role.bicep` because the KV typically lives in a
//     different resource group (sg-acmebot) than this module's scope.
//   - ACMEbot itself (Function App + Easy Auth config + Entra app reg) is
//     deployed once via the upstream ARM template and is NOT managed here.
//
// Idempotency notes:
//   - The identity declaration is a normal `resource` block; ARM treats
//     re-deploys as updates so it's safe to run over an existing identity
//     with the same name.
//   - Role assignments are named with the standard deterministic
//     guid(scope, principal, role) pattern. If an equivalent role assignment
//     already exists with a different (random) name (e.g. created manually
//     via `az role assignment create`), this module will create a SECOND
//     assignment alongside it. Both are functionally equivalent; the old
//     random-named one can be deleted manually after this module deploys
//     successfully — see ARCHITECTURE.md "Apex TLS via BYO cert" for the
//     cleanup command.

@description('Location for the cert reader identity (typically the production primary region).')
param location string

@description('Tags applied to created resources.')
param tags object = {}

@description('Name of the cert reader user-assigned identity to create. Default name is referenced by the workflow bootstrap step and by main.bicep, so override only if you fully control downstream consumers.')
param certReaderIdentityName string = 'id-acme-cert-reader'

@description('Name of the DNS zone (in this module\'s resource group) to grant ACMEbot DNS Zone Contributor on. Empty string skips the DNS role assignment — useful when the zone is managed in a different RG or when the deployment has no custom domain.')
param dnsZoneName string = ''

@description('Principal ID of the ACMEbot Function App\'s system-assigned identity. Required (non-empty) when dnsZoneName is non-empty. Pass via main.bicep using an `existing` reference on the ACMEbot site\'s `identity.principalId`.')
param acmebotPrincipalId string = ''

// Built-in role definition IDs (constant across all Azure tenants).
var dnsZoneContributorRoleId = 'befefa01-2a29-4197-83a8-272ff33ce314'

resource certReaderIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-07-31-preview' = {
  name: certReaderIdentityName
  location: location
  tags: tags
}

resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = if (!empty(dnsZoneName)) {
  name: dnsZoneName
}

resource dnsZoneContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(dnsZoneName) && !empty(acmebotPrincipalId)) {
  scope: dnsZone
  name: guid(dnsZone.id, acmebotPrincipalId, dnsZoneContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', dnsZoneContributorRoleId)
    principalId: acmebotPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Resource ID of the created/adopted cert reader identity. Wire this into container-apps.bicep as certReaderIdentityId.')
output certReaderIdentityId string = certReaderIdentity.id

@description('Principal (object) ID of the cert reader identity — pass to kv-cert-user-role.bicep so the KV role assignment targets the right principal.')
output certReaderPrincipalId string = certReaderIdentity.properties.principalId

@description('Client ID of the cert reader identity (rarely needed downstream — kept for symmetry with userAssignedIdentities output shape).')
output certReaderClientId string = certReaderIdentity.properties.clientId

@description('Name of the cert reader identity (echo of input, useful for logging/diagnostics).')
output certReaderName string = certReaderIdentity.name
