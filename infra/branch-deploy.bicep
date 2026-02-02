// Branch deployment - creates a Container App in the shared production environment
// Prerequisites: Production environment must be deployed first

@description('Sanitized branch name (lowercase, no special chars)')
param branchName string

@description('Custom domain name (e.g., yourdomain.com)')
param customDomainName string = ''

@description('Production subdomain (e.g., app)')
param customSubdomain string = ''

@description('Container image name with tag')
param containerImage string = ''

// Fixed values from production deployment
var environmentName = 'production'
var containerAppsEnvironmentName = 'cae-${environmentName}'

// Branch-specific naming
var containerAppName = 'ca-web-${branchName}'
var branchSubdomain = !empty(customSubdomain) ? '${customSubdomain}-${branchName}' : ''
var useCustomDomain = !empty(customDomainName) && !empty(branchSubdomain)

// Get the container registry name (same formula used in main.bicep)
var registryName = 'cr${replace(environmentName, '-', '')}${uniqueString(resourceGroup().id)}'

// Reference existing Container Apps Environment
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: containerAppsEnvironmentName
}

// Reference existing Container Registry
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

// Branch Container App
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: resourceGroup().location
  tags: {
    'azd-env-name': 'preview-${branchName}'
    'branch': branchName
    'azd-service-name': 'web'
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
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
      containers: [
        {
          name: 'main'
          image: !empty(containerImage) ? '${containerRegistry.properties.loginServer}/${containerImage}' : 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1  // Limit branch deployments to 1 replica
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: '100'
              }
            }
          }
        ]
      }
    }
  }
}

// DNS records for branch (only if custom domain is configured)
module dnsRecords 'core/dns/dns-records.bicep' = if (useCustomDomain) {
  name: 'dns-records-${branchName}'
  params: {
    dnsZoneName: customDomainName
    subdomain: branchSubdomain
    targetHostname: containerApp.properties.configuration.ingress.fqdn
    verificationToken: containerApp.properties.customDomainVerificationId
  }
}

// Outputs
output containerAppName string = containerApp.name
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output uri string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output customDomain string = useCustomDomain ? '${branchSubdomain}.${customDomainName}' : ''
output verificationId string = containerApp.properties.customDomainVerificationId
