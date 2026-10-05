import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compiledPath = process.env.ASTERVOIDS_INFRA_TEMPLATE;
assert.ok(compiledPath, 'Run workflow-helpers.test.sh to compile and select the template first');
const template = JSON.parse(readFileSync(compiledPath, 'utf8'));
const resources = (value, type) => (value.resources ?? []).filter(resource => resource.type === type);
const deployments = resources(template, 'Microsoft.Resources/deployments');
const stores = deployments.filter(deployment =>
  resources(deployment.properties.template, 'Microsoft.Storage/storageAccounts').length > 0);
const apps = deployments.filter(deployment =>
  resources(deployment.properties.template, 'Microsoft.App/containerApps').length > 0);

test('one environment-keyed store survives app revisions and is shared by all production regions', () => {
  assert.equal(stores.length, 1);
  const store = stores[0];
  assert.equal(store.condition, undefined, 'storage is required on every path');
  assert.equal(store.copy, undefined, 'storage must never be provisioned per region');
  assert.equal(store.properties.mode, 'Incremental');
  assert.equal(store.properties.parameters.name.value, "[variables('identityStorageAccountName')]");
  assert.equal(template.variables.identityStorageAccountName,
    "[format('stid{0}', uniqueString(subscription().subscriptionId, if(variables('isStandalone'), variables('standaloneResourceGroupName'), variables('sharedResourceGroupName')), parameters('environmentName')))]");
  assert.equal(template.variables.sharedResourceGroupName, 'rg-production');
  assert.match(template.variables.standaloneResourceGroupName, /parameters\('environmentName'\)/);
  assert.match(store.resourceGroup, /isStandalone.*standaloneResourceGroupName.*sharedResourceGroupName/);
  assert.match(store.properties.parameters.tags.value, /'astervoids-retention', 'manual'/);
  assert.ok(store.dependsOn.every(dependency =>
    !/containerApps|web-|webRegional|identity-access/.test(dependency)));

  assert.equal(apps.length, 4, 'single production, regional production, branch, standalone');
  assert.ok(apps.some(app => app.name === 'web-production'));
  assert.ok(apps.some(app => app.copy?.name === 'webRegional'));
  assert.ok(apps.some(app => app.condition === "[variables('isBranch')]"));
  assert.ok(apps.some(app => app.condition === "[variables('isStandalone')]"));
  const storageInputs = apps.map(app => app.properties.parameters.identityStorageAccountName.value);
  assert.equal(new Set(storageInputs).size, 1, 'every app receives the same environment-scoped store output');
  for (const deployment of apps) {
    assert.match(deployment.properties.parameters.identityStorageAccountName.value,
      /identity-storage-.*outputs\.accountName\.value/);
    assert.match(deployment.properties.parameters.identityTableName.value,
      /identity-storage-.*outputs\.tableName\.value/);
    assert.ok(deployment.dependsOn.some(dependency => dependency.includes('identity-storage-')));
  }
});

test('the preprovisioned table is credential-free, HTTPS-only and independent of regional location', () => {
  const store = stores[0].properties.template;
  const [account] = resources(store, 'Microsoft.Storage/storageAccounts');
  assert.equal(account.location, '[resourceGroup().location]');
  assert.equal(account.kind, 'StorageV2');
  assert.equal(account.sku.name, 'Standard_LRS');
  assert.equal(account.properties.allowSharedKeyAccess, false);
  assert.equal(account.properties.allowBlobPublicAccess, false);
  assert.equal(account.properties.supportsHttpsTrafficOnly, true);
  assert.equal(account.properties.minimumTlsVersion, 'TLS1_2');
  assert.equal(account.properties.defaultToOAuthAuthentication, true);
  assert.equal(resources(store, 'Microsoft.Storage/storageAccounts/tableServices').length, 1);
  const tables = resources(store, 'Microsoft.Storage/storageAccounts/tableServices/tables');
  assert.equal(tables.length, 1);
  assert.equal(store.variables.tableName, 'PlayerIdentity');
  assert.match(tables[0].name, /'default', variables\('tableName'\)/);
  assert.doesNotMatch(JSON.stringify(store), /listKeys|AccountKey|connectionString|sharedAccessSignature/i);
});

test('every app uses its own system principal and a principal-aware table-scoped grant', () => {
  for (const deployment of apps) {
    const module = deployment.properties.template;
    const [app] = resources(module, 'Microsoft.App/containerApps');
    assert.deepEqual(app.identity, { type: 'SystemAssigned' });
    const [grant] = resources(module, 'Microsoft.Resources/deployments');
    assert.match(grant.properties.parameters.principalId.value,
      /reference\(resourceId\('Microsoft\.App\/containerApps', parameters\('name'\)\).*\.identity\.principalId/);
    assert.equal(grant.properties.parameters.storageAccountName.value, "[parameters('identityStorageAccountName')]");
    assert.equal(grant.properties.parameters.tableName.value, "[parameters('identityTableName')]");
    assert.ok(grant.dependsOn.some(dependency => dependency.includes('Microsoft.App/containerApps')));
    assert.ok((app.dependsOn ?? []).every(dependency => !dependency.includes('identity-access')));
    const policy = grant.properties.template;
    assert.equal(policy.variables.storageTableDataContributorRoleId, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3');
    const [role] = resources(policy, 'Microsoft.Authorization/roleAssignments');
    assert.equal(policy.resources.length, 1);
    assert.equal(role.scope,
      "[resourceId('Microsoft.Storage/storageAccounts/tableServices/tables', parameters('storageAccountName'), 'default', parameters('tableName'))]");
    assert.match(role.name, /guid\(resourceId\(.*tables'.*parameters\('principalId'\)/);
    assert.equal(role.properties.principalId, "[parameters('principalId')]");
    assert.equal(role.properties.principalType, 'ServicePrincipal');
    assert.equal(role.properties.roleDefinitionId,
      "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', variables('storageTableDataContributorRoleId'))]");
    assert.doesNotMatch(JSON.stringify(grant), /certReaderIdentityId|KeyVault|listKeys/);
  }
});

test('runtime identity configuration cannot fall back, override credentials, or target an external endpoint', () => {
  assert.equal(template.parameters.identityPromptOnRoot.type, 'bool');
  assert.equal(template.parameters.identityPromptOnRoot.defaultValue, true);
  assert.deepEqual(Object.keys(template.parameters).filter(name => /^identity/i.test(name)), ['identityPromptOnRoot']);
  for (const deployment of apps) {
    assert.equal(deployment.properties.parameters.identityPromptOnRoot.value, "[parameters('identityPromptOnRoot')]");
    const module = deployment.properties.template;
    assert.equal(module.parameters.identityStorageAccountName.defaultValue, undefined);
    assert.equal(module.parameters.identityTableName.defaultValue, undefined);
    const [app] = resources(module, 'Microsoft.App/containerApps');
    const env = app.properties.template.containers[0].env;
    assert.match(env, /filter\(parameters\('env'\).*not\(startsWith\(toLower\(lambdaVariables\('item'\)\.name\), 'identity__'\)\)/);
    assert.match(env, /'Identity__Provider', 'value', 'AzureTable'/);
    assert.match(env, /'Identity__TableEndpoint', 'value', reference\(resourceId\('Microsoft\.Storage\/storageAccounts', parameters\('identityStorageAccountName'\)\).*\.primaryEndpoints\.table/);
    assert.match(env, /'Identity__TableName', 'value', parameters\('identityTableName'\)/);
    assert.match(env, /'Identity__PromptOnRoot', 'value', string\(parameters\('identityPromptOnRoot'\)\)/);
    assert.doesNotMatch(env, /listKeys|connectionString|AccountKey|SharedAccessSignature|'File'|'Memory'/i);
    assert.ok(app.properties.configuration.secrets.every(secret => secret.name === 'registry-password'),
      'identity must not add shared-secret credentials');
  }
});

test('every deployment declares exact HTTPS origins for identity requests behind TLS termination', () => {
  for (const deployment of apps) {
    const module = deployment.properties.template;
    const [app] = resources(module, 'Microsoft.App/containerApps');
    const env = app.properties.template.containers[0].env;
    assert.match(env, /'Region__AdditionalAllowedOrigins__0', 'value', format\('https:\/\/\{0\}\.\{1\}', parameters\('name'\), reference\(resourceId\('Microsoft\.App\/managedEnvironments', parameters\('containerAppsEnvironmentName'\)\).*\.defaultDomain\)/,
      'the default HTTPS app origin must come from the app name and its actual environment');
    assert.equal(module.variables.configuredAdditionalOrigins,
      "[union(parameters('additionalAllowedOrigins'), if(empty(parameters('customDomainName')), createArray(), createArray(format('https://{0}', parameters('customDomainName')))), if(empty(parameters('additionalCustomDomain')), createArray(), createArray(format('https://{0}', parameters('additionalCustomDomain')))))]");
    const additionalOrigins = module.variables.copy.find(copy => copy.name === 'additionalOriginEnv');
    assert.equal(additionalOrigins.count, "[length(variables('configuredAdditionalOrigins'))]");
    assert.equal(additionalOrigins.input.name,
      "[format('Region__AdditionalAllowedOrigins__{0}', add(copyIndex('additionalOriginEnv'), 1))]");
    assert.equal(additionalOrigins.input.value,
      "[variables('configuredAdditionalOrigins')[copyIndex('additionalOriginEnv')]]");
    assert.match(env, /variables\('additionalOriginEnv'\)/);
    assert.doesNotMatch(env, /ASPNETCORE_FORWARDEDHEADERS_ENABLED/,
      'origin validation must not trust arbitrary forwarded headers');
    assert.equal(app.properties.configuration.ingress.allowInsecure, false);
  }
});

test('identity resource details do not become public deployment outputs', () => {
  assert.doesNotMatch(JSON.stringify(template.outputs),
    /identityStorage|identityTable|identity-access|primaryEndpoints\.table/);
});

test('orphan cleanup never deletes the retained identity store or its resource group', () => {
  const cleanup = readFileSync(new URL('../workflows/cleanup-orphans.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(cleanup, /az\s+(?:storage|resource|group)\s+[^#\n]*\bdelete\b/);
});
