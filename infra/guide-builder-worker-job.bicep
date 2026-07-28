targetScope = 'resourceGroup'

@description('Azure region for the Guide Builder worker job.')
param location string = resourceGroup().location

@allowed([
  'qa'
  'production'
])
@description('Closed deployment environment selector. It also fixes the exact SQL database name.')
param portalEnvironment string

@description('Container Apps job name.')
param jobName string

@description('Immutable ACR image reference including its sha256 digest.')
param workerImage string

@description('Enable the reviewed production cron. QA and dark production deployments remain manual.')
param enableSchedule bool = false

@minValue(1)
@maxValue(30)
@description('Minutes between scheduled production executions.')
param scheduleMinutes int = 5

@minValue(1)
@maxValue(25)
@description('Maximum jobs drained serially by one Container Apps Job execution.')
param maxJobsPerExecution int = 10

@description('Existing Container Apps managed environment.')
param containerAppsEnvironmentName string = 'erpupdsch4645-guide-env'

@description('Existing Guide Builder user-assigned managed identity.')
param workerIdentityName string = 'erpupdsch4645-guide-mi'

@description('Existing Azure Container Registry.')
param containerRegistryName string = 'erpupdschguideacr'

@description('Existing Guide Builder-only Key Vault.')
param keyVaultName string = 'erpupdsch4645-guide-kv'

@description('Key Vault secret name for the SQL runtime password.')
param sqlPasswordSecretName string = 'PortalSAGWeb-GuideSqlRuntime-Password'

@description('Key Vault secret name for the OpenAI API key.')
param openAiSecretName string = 'PortalSAGWeb-GuideOpenAI-ApiKey'

@description('SQL Server TCP endpoint, including the reviewed non-default port.')
param sqlServerHost string = 'data14.sagerp.co,54103'

@description('Least-privilege Portal SAG Web application login.')
param sqlUsername string = 'SAGWebDev'

@description('Azure Blob account used by Portal SAG Web private content.')
param blobStorageAccountName string = 'sagwebiastorage'

@description('Azure Blob container used by Portal SAG Web private content.')
param blobStorageContainer string = 'portal-sag-content'

@description('Private object prefix reserved for runtime content.')
param objectStoragePrefix string = 'portal-sag/runtime'

@description('OpenAI model used for the structured guide draft and final pass.')
param draftModel string = 'gpt-5.6-sol'

@description('OpenAI model used to transcribe extracted audio.')
param transcriptionModel string = 'whisper-1'

var sqlDatabase = portalEnvironment == 'qa' ? 'PortalSAGWeb-TEST' : 'PortalSAGWeb'
var keyVaultUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}'
var sqlPasswordSecretUri = '${keyVaultUri}/secrets/${sqlPasswordSecretName}'
var openAiSecretUri = '${keyVaultUri}/secrets/${openAiSecretName}'
var blobStorageAccountUrl = 'https://${blobStorageAccountName}.blob.${environment().suffixes.storage}'
var scheduleEnabled = portalEnvironment == 'production' && enableSchedule
var triggerConfiguration = scheduleEnabled
  ? {
      scheduleTriggerConfig: {
        cronExpression: '*/${scheduleMinutes} * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
  : {
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
    }

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workerIdentityName
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource workerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: union({
      triggerType: scheduleEnabled ? 'Schedule' : 'Manual'
      replicaTimeout: 3600
      replicaRetryLimit: 0
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: workerIdentity.id
        }
      ]
      secrets: [
        {
          name: 'sql-password'
          keyVaultUrl: sqlPasswordSecretUri
          identity: workerIdentity.id
        }
        {
          name: 'openai-api-key'
          keyVaultUrl: openAiSecretUri
          identity: workerIdentity.id
        }
      ]
    }, triggerConfiguration)
    template: {
      containers: [
        {
          name: 'guide-worker'
          image: workerImage
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORTAL_SAG_ENVIRONMENT'
              value: portalEnvironment
            }
            {
              name: 'SQL_SERVER_HOST'
              value: sqlServerHost
            }
            {
              name: 'SQL_DATABASE'
              value: sqlDatabase
            }
            {
              name: 'SQL_USERNAME'
              value: sqlUsername
            }
            {
              name: 'SQL_PASSWORD'
              secretRef: 'sql-password'
            }
            {
              name: 'SQL_CONNECTION_TIMEOUT_MS'
              value: '30000'
            }
            {
              name: 'SQL_REQUEST_TIMEOUT_MS'
              value: '120000'
            }
            {
              name: 'SQL_POOL_MAX'
              value: '2'
            }
            {
              name: 'OBJECT_STORAGE_PROVIDER'
              value: 'azure_blob'
            }
            {
              name: 'OBJECT_STORAGE_PREFIX'
              value: objectStoragePrefix
            }
            {
              name: 'OBJECT_STORAGE_SIGNED_URL_SECONDS'
              value: '300'
            }
            {
              name: 'AZURE_BLOB_STORAGE_ACCOUNT_URL'
              value: blobStorageAccountUrl
            }
            {
              name: 'AZURE_BLOB_STORAGE_CONTAINER'
              value: blobStorageContainer
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: workerIdentity.properties.clientId
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
            {
              name: 'GUIDE_BUILDER_ENABLED'
              value: 'true'
            }
            {
              name: 'GUIDE_WORKER_ENABLED'
              value: 'true'
            }
            {
              name: 'GUIDE_WORKER_PROCESSOR_CERTIFIED'
              value: 'true'
            }
            {
              name: 'GUIDE_WORKER_HOST_MODE'
              value: 'drain'
            }
            {
              name: 'GUIDE_WORKER_MAX_JOBS_PER_EXECUTION'
              value: string(maxJobsPerExecution)
            }
            {
              name: 'GUIDE_DRAFT_MODEL'
              value: draftModel
            }
            {
              name: 'GUIDE_VISION_MODEL'
              value: draftModel
            }
            {
              name: 'GUIDE_TRANSCRIPTION_MODEL'
              value: transcriptionModel
            }
            {
              name: 'GUIDE_MAX_ACTIVE_SESSIONS_PER_OWNER'
              value: '2'
            }
            {
              name: 'GUIDE_MAX_CREATIONS_PER_OWNER_DAY'
              value: '5'
            }
            {
              name: 'GUIDE_MAX_ANSWER_ROUNDS'
              value: '3'
            }
          ]
          resources: {
            cpu: 2
            memory: '4Gi'
          }
        }
      ]
    }
  }
  tags: {
    application: 'Portal SAG Web'
    component: 'Guide Builder Worker'
    environment: portalEnvironment
    managedBy: 'Bicep'
  }
}

output jobId string = workerJob.id
output jobName string = workerJob.name
output environment string = portalEnvironment
output sqlDatabase string = sqlDatabase
output workerImage string = workerImage
output scheduleEnabled bool = scheduleEnabled
output maxJobsPerExecution int = maxJobsPerExecution
