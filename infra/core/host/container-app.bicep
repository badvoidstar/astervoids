@description('Name of the Container App')
param name string

@description('Location for resources')
param location string = resourceGroup().location

@description('Tags for resources')
param tags object = {}

@description('Name of the Container Apps Environment')
param containerAppsEnvironmentName string

@description('Name of the Container Registry')
param containerRegistryName string

@description('Container image name (leave empty for initial deployment)')
param imageName string = ''

@description('Target port for the container')
param targetPort int = 8080

@description('Allow external ingress')
param external bool = true

@description('Minimum number of replicas')
param minReplicas int = 0

@description('Maximum number of replicas')
param maxReplicas int = 1

@description('CPU cores allocated to the container')
param cpu string = '1.0'

@description('Memory allocated to the container')
param memory string = '2Gi'

@description('Environment variables for the container')
param env array = []

@description('Custom domain name (optional, e.g., app.yourdomain.com)')
param customDomainName string = ''

@description('Region id stamped into the running container as Region__Id (RegionSettings.Id). When empty, no Region__Id env var is injected and the container uses the value from appsettings.json (defaults to "local").')
param regionId string = ''

@description('Human-readable region name stamped into the running container as Region__DisplayName (RegionSettings.DisplayName). Ignored when regionId is empty.')
param regionDisplayName string = ''

@description('Scale-down cooldown in seconds. Container Apps waits this long after the last connection closes before scaling to zero. The plan target is 60s — short enough that idle regions return to zero quickly between picker bursts, long enough to absorb a single missed keep-alive without flapping replicas.')
param cooldownPeriodSeconds int = 60

@description('Grace period for in-flight requests when a replica is being terminated. SignalR connections drain cleanly via the existing LeaveSession path during this window — 30s is comfortable for that and matches the plan.')
param terminationGracePeriodSeconds int = 30

@description('HTTP scale rule concurrentRequests threshold. With maxReplicas=1 and SessionService held in-memory (non-shardable), this is a single-replica trigger; lowering from the previous 100 to 50 makes the runtime react sooner to load spikes.')
param concurrentRequestsPerReplica int = 50

// Reference existing Container Apps Environment
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-10-02-preview' existing = {
  name: containerAppsEnvironmentName
}

// Reference existing Container Registry
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

// Merge the caller-provided env array with the regional env vars synthesised from
// regionId / regionDisplayName. The regional pair takes precedence over any
// duplicate names in `env` so a misconfigured caller can't shadow them.
var regionalEnv = empty(regionId) ? [] : [
  { name: 'Region__Id', value: regionId }
  { name: 'Region__DisplayName', value: empty(regionDisplayName) ? regionId : regionDisplayName }
]
var effectiveEnv = concat(env, regionalEnv)

// Container App.
//
// API version 2024-10-02-preview is required for properties.template.scale.cooldownPeriod
// (the scale-to-zero cooldown knob). 2024-03-01 GA doesn't expose it. We accept the
// preview risk because the only preview property we depend on is cooldownPeriod —
// everything else is GA-stable.
resource containerApp 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: name
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: external
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        // Add custom domain without certificate first to allow DNS verification
        customDomains: !empty(customDomainName) ? [
          {
            name: customDomainName
            bindingType: 'Disabled'  // Start without TLS, will be enabled after cert is issued
          }
        ] : []
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          username: containerRegistry.listCredentials().username
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: [
        {
          name: 'registry-password'
          value: containerRegistry.listCredentials().passwords[0].value
        }
      ]
    }
    template: {
      // SignalR connections drain via the existing LeaveSession path during
      // termination; this gives that path enough time before SIGKILL.
      terminationGracePeriodSeconds: terminationGracePeriodSeconds
      containers: [
        {
          name: 'main'
          image: !empty(imageName) ? '${containerRegistry.properties.loginServer}/${imageName}' : 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: effectiveEnv
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        // Aggressive cooldown so regions return to zero shortly after the
        // last picker visitor leaves, satisfying the scale-to-zero
        // requirement without sacrificing in-session warmth.
        cooldownPeriod: cooldownPeriodSeconds
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: string(concurrentRequestsPerReplica)
              }
            }
          }
        ]
      }
    }
  }
}

output name string = containerApp.name
output uri string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output id string = containerApp.id
output fqdn string = containerApp.properties.configuration.ingress.fqdn
output verificationId string = containerApp.properties.customDomainVerificationId
