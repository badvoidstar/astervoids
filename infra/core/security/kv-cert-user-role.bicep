// Key Vault Certificate User role assignment for the BYO cert reader identity.
//
// This module exists as a SEPARATE file (rather than living inside
// acmebot-permissions.bicep) because the Key Vault holding the BYO wildcard
// cert typically lives in a different resource group than the cert reader
// identity:
//
//   - cert reader identity:  rg-production       (created by acmebot-permissions.bicep)
//   - Key Vault holding cert: sg-acmebot          (created by ACMEbot's ARM template)
//
// Bicep modules can only have ONE scope, so the role assignment must be in
// a module scoped to the KV's resource group. main.bicep invokes this
// module with `scope: resourceGroup(acmebotKeyVaultResourceGroup)`.
//
// Idempotency: deterministic guid(scope, principal, role) name; safe to
// re-deploy. If a duplicate manual assignment exists with a random name, a
// second assignment will be created — Azure treats them as equivalent;
// clean up manually after first successful deploy.

@description('Name of the Key Vault holding the BYO cert. Must already exist in this module\'s scoped resource group (typically sg-acmebot).')
param keyVaultName string

@description('Principal ID of the identity to grant Key Vault Certificate User on. Typically the certReaderPrincipalId output of acmebot-permissions.bicep.')
param principalId string

// Built-in role definition IDs (constant across all Azure tenants).
// Key Vault Certificate User: read certificate content (including private key
// material from KV secrets endpoint). This is the minimum role ACA needs to
// pull a BYO cert; broader roles (Reader, Secrets User) would also work but
// violate least privilege.
var keyVaultCertificateUserRoleId = 'db79e9a7-68ee-4b58-9aeb-b90e7c24fcba'

resource keyVault 'Microsoft.KeyVault/vaults@2024-04-01-preview' existing = {
  name: keyVaultName
}

resource keyVaultCertUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, principalId, keyVaultCertificateUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultCertificateUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
