@description('Name of this environment\'s provisioned identity storage account.')
param storageAccountName string

@description('Name of the provisioned identity table.')
param tableName string

@description('System-assigned principal of a Container App, created before this module runs.')
param principalId string

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: account
  name: 'default'
}

resource table 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = {
  parent: tableService
  name: tableName
}

var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

// Including the principal makes an app recreation a new assignment instead
// of an illegal update of an assignment belonging to its deleted identity.
resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: table
  name: guid(table.id, principalId, storageTableDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
