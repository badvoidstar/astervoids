@description('Name of the Static Web App resource.')
param name string

@description('Azure region for the Static Web App.')
param location string

@description('Tags for resources.')
param tags object = {}

@description('SKU for the Static Web App.')
@allowed([
  'Free'
  'Standard'
])
param skuName string = 'Free'

resource staticWebApp 'Microsoft.Web/staticSites@2024-04-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuName
  }
  properties: {}
}

output name string = staticWebApp.name
output id string = staticWebApp.id
output defaultHostname string = staticWebApp.properties.defaultHostname
