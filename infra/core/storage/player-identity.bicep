@description('Stable storage account name for this deployment environment, never a regional app or image revision.')
param name string

@description('Tags for resources')
param tags object = {}

var tableName = 'PlayerIdentity'

// One primary table endpoint is shared by every app in this environment.
// Keep the account in the RG home location, not the selected gameplay region.
resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: resourceGroup().location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: account
  name: 'default'
}

// Provision the table before any app starts. The runtime must never create a
// missing table or a replacement store.
resource table 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: tableName
}

output accountName string = account.name
output tableName string = table.name
