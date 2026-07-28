targetScope = 'resourceGroup'

@description('Existing Portal SAG Web private storage account.')
param storageAccountName string = 'sagwebiastorage'

@description('Existing private content container.')
param storageContainerName string = 'portal-sag-content'

@description('Guide Builder worker managed identity principal ID.')
param workerPrincipalId string

@description('Existing/adopted role-assignment resource name for container data access.')
param blobDataContributorAssignmentName string = '8fadcbb1-055d-4aa8-bf8d-2cdcaeadbd7a'

@description('Existing/adopted role-assignment resource name for account delegation-key access.')
param blobDelegatorAssignmentName string = '577b4430-a3ea-4ba3-b1f7-a154ae2d2306'

@description('Exact browser origins permitted to use signed Blob URLs.')
param allowedOrigins array = [
  'https://agreeable-wave-07469d50f.7.azurestaticapps.net'
]

var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var storageBlobDelegatorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
)

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: allowedOrigins
          allowedMethods: [
            'GET'
            'HEAD'
            'OPTIONS'
            'PUT'
          ]
          allowedHeaders: [
            'Content-Type'
            'x-ms-blob-type'
            'x-ms-meta-declaredsize'
            'x-ms-version'
            'x-ms-date'
            'x-ms-client-request-id'
          ]
          exposedHeaders: [
            'ETag'
            'Content-Length'
            'Content-Type'
            'Content-Range'
            'Accept-Ranges'
            'x-ms-request-id'
            'x-ms-version'
          ]
          maxAgeInSeconds: 300
        }
      ]
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 7
      allowPermanentDelete: false
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    isVersioningEnabled: true
  }
}

resource privateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: storageContainerName
}

resource workerBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: blobDataContributorAssignmentName
  scope: privateContainer
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

resource workerBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: blobDelegatorAssignmentName
  scope: storageAccount
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDelegatorRoleDefinitionId
  }
}

output storageAccountId string = storageAccount.id
output storageContainerId string = privateContainer.id
output workerPrincipalId string = workerPrincipalId
output allowedOrigins array = allowedOrigins
