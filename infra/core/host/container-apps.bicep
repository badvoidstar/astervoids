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
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: name
  location: location
  tags: tags
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
