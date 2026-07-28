targetScope = 'resourceGroup'

@description('Azure region for the Guide Builder platform.')
param location string = resourceGroup().location

@description('Globally unique Azure Container Registry name.')
param containerRegistryName string = 'erpupdschguideacr'

@description('Guide Builder-only Key Vault name.')
param keyVaultName string = 'erpupdsch4645-guide-kv'

@description('User-assigned managed identity used only by the Guide Builder worker.')
param workerIdentityName string = 'erpupdsch4645-guide-mi'

@description('Log Analytics workspace used by the Container Apps environment.')
param logAnalyticsWorkspaceName string = 'erpupdsch4645-guide-logs'

@description('Virtual network for deterministic Guide Builder worker egress.')
param virtualNetworkName string = 'erpupdsch4645-guide-vnet'

@description('Subnet delegated exclusively to the Container Apps environment.')
param infrastructureSubnetName string = 'aca-infrastructure'

@description('Static public IP used by the worker NAT gateway.')
param outboundPublicIpName string = 'erpupdsch4645-guide-egress-ip'

@description('NAT gateway for deterministic provider allow-listing.')
param natGatewayName string = 'erpupdsch4645-guide-nat'

@description('Container Apps managed environment. The worker job is deployed separately.')
param containerAppsEnvironmentName string = 'erpupdsch4645-guide-env'

@minValue(30)
@maxValue(730)
@description('Log retention in days.')
param logRetentionDays int = 30

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    retentionInDays: logRetentionDays
    sku: {
      name: 'PerGB2018'
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: containerRegistryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
    policies: {
      quarantinePolicy: {
        status: 'disabled'
      }
      trustPolicy: {
        status: 'disabled'
        type: 'Notary'
      }
    }
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

resource guideVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: workerIdentityName
  location: location
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

resource workerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, workerIdentity.id, acrPullRoleDefinitionId)
  scope: containerRegistry
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource workerKeyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(guideVault.id, workerIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: guideVault
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource outboundPublicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: outboundPublicIpName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    idleTimeoutInMinutes: 10
    ddosSettings: {
      protectionMode: 'VirtualNetworkInherited'
    }
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2023-11-01' = {
  name: natGatewayName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [
      {
        id: outboundPublicIp.id
      }
    ]
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: virtualNetworkName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: infrastructureSubnetName
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [
            {
              name: 'MicrosoftAppEnvironments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
          natGateway: {
            id: natGateway.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
          privateLinkServiceNetworkPolicies: 'Enabled'
        }
      }
    ]
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppsEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
    vnetConfiguration: {
      infrastructureSubnetId: '${virtualNetwork.id}/subnets/${infrastructureSubnetName}'
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder'
    environment: 'production'
    managedBy: 'Bicep'
  }
}

output containerRegistryId string = containerRegistry.id
output containerRegistryLoginServer string = containerRegistry.properties.loginServer
output containerAppsEnvironmentId string = containerAppsEnvironment.id
output guideKeyVaultId string = guideVault.id
output guideKeyVaultUri string = guideVault.properties.vaultUri
output workerIdentityId string = workerIdentity.id
output workerIdentityClientId string = workerIdentity.properties.clientId
output workerIdentityPrincipalId string = workerIdentity.properties.principalId
output outboundPublicIpAddress string = outboundPublicIp.properties.ipAddress
