targetScope = 'resourceGroup'

@description('Front Door profile name')
param profileName string

@description('Host name of the primary static origin (regional container app FQDN)')
param originHostName string

@description('Static route patterns to match')
param staticRoutePatterns array

@description('Optional custom domain host name')
param customDomainHostName string = ''

@description('Common tags')
param tags object = {}

var useCustomDomain = !empty(customDomainHostName)

resource profile 'Microsoft.Cdn/profiles@2023-05-01' = {
  name: profileName
  location: 'global'
  sku: {
    name: 'Standard_AzureFrontDoor'
  }
  tags: tags
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2023-05-01' = {
  name: 'global-static'
  parent: profile
  location: 'global'
  properties: {
    enabledState: 'Enabled'
  }
}

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2023-05-01' = {
  name: 'static-origin-group'
  parent: profile
  properties: {
    healthProbeSettings: {
      probePath: '/index.html'
      probeRequestType: 'GET'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 120
    }
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 0
    }
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2023-05-01' = {
  name: 'primary-static-origin'
  parent: originGroup
  properties: {
    hostName: originHostName
    originHostHeader: originHostName
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
  }
}

resource defaultRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2023-05-01' = {
  name: 'static-default'
  parent: endpoint
  properties: {
    originGroup: {
      id: originGroup.id
    }
    supportedProtocols: [
      'Http'
      'Https'
    ]
    patternsToMatch: staticRoutePatterns
    forwardingProtocol: 'MatchRequest'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    enabledState: 'Enabled'
  }
}

resource customDomain 'Microsoft.Cdn/profiles/customDomains@2023-05-01' = if (useCustomDomain) {
  name: 'static-${replace(customDomainHostName, '.', '-')}'
  parent: profile
  properties: {
    hostName: customDomainHostName
    tlsSettings: {
      certificateType: 'ManagedCertificate'
      minimumTlsVersion: 'TLS12'
    }
  }
}

resource customRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2023-05-01' = if (useCustomDomain) {
  name: 'static-custom-domain'
  parent: endpoint
  properties: {
    originGroup: {
      id: originGroup.id
    }
    supportedProtocols: [
      'Http'
      'Https'
    ]
    patternsToMatch: staticRoutePatterns
    forwardingProtocol: 'MatchRequest'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Disabled'
    customDomains: [
      {
        id: customDomain.id
      }
    ]
    enabledState: 'Enabled'
  }
}

output endpointHostName string = endpoint.properties.hostName
