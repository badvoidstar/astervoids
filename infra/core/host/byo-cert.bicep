// =============================================================================
// Standalone BYO certificate resource — attaches a Key Vault-stored cert to an
// EXISTING Container Apps Environment.
//
// Why a separate module: branch deploys reference an existing CAE
// (`cae-production`) but still need the BYO cert to be present there before
// their container app's `ingress.customDomains[].certificateId` binding can
// succeed. The full container-apps.bicep also creates the CAE + ACR + log
// workspace, which is wrong for branches. This module is the minimal
// "ensure cert exists on this CAE" primitive that both production and branch
// deploys can invoke without conflicts.
//
// The cert resource is idempotent: re-deploying with the same KV secret URL
// and identity is a no-op. So both production and branch deploys can each
// declare the cert independently without stepping on each other.
// =============================================================================

@description('Name of the existing Container Apps Environment to attach the cert to.')
param environmentName string

@description('Cert resource name on the CAE. Stable string so all callers (production multi-region per-region, single-region production, branch deploys) reference the same id.')
param name string

@description('Location (defaults to the resource group). Cert is a child of the CAE so really inherits the CAE region; this param exists only because Azure requires location on every resource.')
param location string = resourceGroup().location

@description('Full Key Vault secret URL of the cert to bind, e.g. `https://my-kv.vault.azure.net/secrets/wildcard-your-domain-com`.')
param keyVaultUrl string

@description('Resource ID of a user-assigned managed identity that has Key Vault Certificate User role on the KV. Azure uses this identity to fetch the cert during creation; it must already have RBAC grant at deploy time.')
param identityResourceId string

@description('Tags applied to the cert resource.')
param tags object = {}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-10-02-preview' existing = {
  name: environmentName
}

resource byoCert 'Microsoft.App/managedEnvironments/certificates@2024-10-02-preview' = {
  parent: containerAppsEnvironment
  name: name
  location: location
  tags: tags
  properties: {
    certificateKeyVaultProperties: {
      identity: identityResourceId
      keyVaultUrl: keyVaultUrl
    }
  }
}

@description('Resource ID of the cert. Use this in `containerApp.properties.configuration.ingress.customDomains[].certificateId`.')
output certificateResourceId string = byoCert.id
