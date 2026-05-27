@description('Name of the Container Apps Environment')
param name string

@description('Location for resources')
param location string = resourceGroup().location

@description('Tags for resources')
param tags object = {}

@description('Name of the Azure Container Registry')
param containerRegistryName string

@description('Whether this module should create the Azure Container Registry. In multi-region deployments, secondary regions share the primary region ACR — set false on secondary regions and the primary region (default true) will create it.')
param createRegistry bool = true

@description('BYO cert (optional). Full Key Vault secret URL pointing at the cert to bind, e.g. `https://my-kv.vault.azure.net/secrets/wildcard-your-domain-com`. When set, this module emits a Microsoft.App/managedEnvironments/certificates resource pulling the cert into this CAE so container apps in this env can bind their custom domain to it. When empty, no cert resource is emitted — the managed-cert flow (workflow-driven, DigiCert-issued, CNAME-validated) is used instead.')
param certKeyVaultSecretUrl string = ''

@description('BYO cert (optional). Name to give the certificate resource on the CAE. Used both as the resource name and as the cert identifier referenced by container apps. Typically a stable name like `wildcard-your-domain-com` so all regions pick up the same cert.')
param certKeyVaultCertName string = ''

@description('BYO cert (optional). Resource ID of a user-assigned managed identity that has Key Vault Certificate User role on the KV holding the cert. Azure uses this identity to fetch the cert during creation. Required when certKeyVaultSecretUrl is set.')
param certReaderIdentityId string = ''

// Whether BYO cert is enabled — all three params must be set together to
// avoid half-configured certificate resources at deploy time.
var byoCertEnabled = !empty(certKeyVaultSecretUrl) && !empty(certKeyVaultCertName) && !empty(certReaderIdentityId)

// Log Analytics workspace for Container Apps
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// Container Apps Environment
//
// When BYO cert is enabled, the CAE attaches the cert-reader user-assigned
// managed identity so the child `certificates` resource below can reference
// it via `certificateKeyVaultProperties.identity`. Without this attachment
// Azure rejects cert creation with `ManagedEnvironmentIdentityNotExist`
// — the identity must already be a principal of the environment before
// any cert resource on it can name it.
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: name
  location: location
  tags: tags
  identity: byoCertEnabled ? {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${certReaderIdentityId}': {}
    }
  } : null
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// BYO cert from Key Vault — single resource per CAE, referenced by every
// container app in this env that needs to serve the wildcard hostname.
// `certificateKeyVaultProperties.identity` must already have Key Vault
// Certificate User role on the KV at deploy time, or this resource creation
// fails with 'Forbidden' from Azure during the first deploy.
resource byoCert 'Microsoft.App/managedEnvironments/certificates@2024-10-02-preview' = if (byoCertEnabled) {
  parent: containerAppsEnvironment
  name: certKeyVaultCertName
  location: location
  tags: tags
  properties: {
    certificateKeyVaultProperties: {
      identity: certReaderIdentityId
      keyVaultUrl: certKeyVaultSecretUrl
    }
  }
}

// Azure Container Registry — created only by the primary region. Secondary
// regions reference the same registry by name (geo-pull cost is paid once
// per cold start; in practice the image fits in MB and pulls are fast).
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = if (createRegistry) {
  name: containerRegistryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

// Reference the registry uniformly whether we created it or are sharing one
// created elsewhere. Lookups via `existing` are cheap and let us emit a
// stable `registryLoginServer` output regardless of which branch ran.
resource existingRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (!createRegistry) {
  name: containerRegistryName
}

output environmentName string = containerAppsEnvironment.name
output environmentId string = containerAppsEnvironment.id
output registryName string = containerRegistryName
#disable-next-line BCP318
output registryLoginServer string = createRegistry ? containerRegistry.properties.loginServer : existingRegistry.properties.loginServer

@description('Resource ID of the BYO cert resource on this CAE, or empty string when BYO cert is not configured. Container apps in this env reference this ID in their ingress.customDomains[].certificateId.')
#disable-next-line BCP318
output byoCertResourceId string = byoCertEnabled ? byoCert.id : ''
