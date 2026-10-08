import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const resourceGroup = 'rg-production';
const appPrefix = 'ca-web-';
const environmentPrefix = 'cae-production';
const guid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const script = name => fileURLToPath(new URL(name, import.meta.url));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const branchEnvironment = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,23}[a-z0-9])?$/.test(value);
const execute = (command, args) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024
});

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function tableEndpoint(value) {
  // This deployment uses Azure public-cloud Table endpoints, never aliases,
  // credentials, connection strings or secret references.
  requireEvidence(typeof value === 'string' &&
    /^https:\/\/[a-z0-9]{3,24}\.table\.core\.windows\.net\/?$/i.test(value),
  'Incomplete or unsupported app/storage Table endpoint; cleanup stopped.');
  return value.toLowerCase().replace(/\/$/, '');
}

export function createCleanup({ run = execute, log = console.log } = {}) {
  const sanitized = new Map();
  const call = (command, args, failure) => {
    try {
      return run(command, args).replace(/\r/g, '').trimEnd();
    } catch {
      // CLI errors and inventories can contain private hostnames and IDs.
      throw new Error(failure);
    }
  };
  const az = (args, failure, output = 'json') => call('az',
    [...args, '--resource-group', resourceGroup, '--only-show-errors', '--output', output], failure);
  const array = (text, description) => {
    let value;
    try { value = JSON.parse(text); } catch { /* Report only the safe description. */ }
    requireEvidence(Array.isArray(value), `${description} is not a complete JSON array; cleanup stopped.`);
    return value;
  };
  const unique = (values, description) => requireEvidence(
    new Set(values).size === values.length, `Ambiguous ${description}; cleanup stopped.`);
  const sanitize = branch => {
    if (!sanitized.has(branch)) {
      const value = call('bash', [script('sanitize-branch-name.sh'), branch], 'Branch sanitization failed.');
      requireEvidence(branchEnvironment(value), 'Invalid sanitized branch inventory; cleanup stopped.');
      sanitized.set(branch, value);
    }
    return sanitized.get(branch);
  };
  const protectedSuffix = (suffix, active) => {
    const result = call('bash', [script('orphan-safety.sh'), suffix, [...active].join(' ')],
      'Deployment protection check failed.');
    requireEvidence(result === 'protected' || result === 'orphan', 'Invalid deployment protection result.');
    return result === 'protected';
  };
  const branches = () => {
    const text = call('git', ['ls-remote', '--heads', 'origin'], 'Remote branch discovery failed; cleanup stopped.');
    const refs = new Map();
    for (const line of text.split('\n')) {
      const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\trefs\/heads\/(\S+)$/.exec(line);
      requireEvidence(match && !refs.has(match[2]), 'Incomplete or ambiguous remote branch inventory; cleanup stopped.');
      call('git', ['check-ref-format', `refs/heads/${match[2]}`], 'Malformed remote branch inventory; cleanup stopped.');
      refs.set(match[2], match[1]);
    }
    // main is permanent in this repository. Empty/truncated discovery must not
    // turn every deployment into an orphan.
    requireEvidence(refs.has('main'), 'Remote branch inventory is missing main; cleanup stopped.');
    return { refs, suffixes: new Set([...refs.keys()].map(sanitize)) };
  };
  const resources = (args, type) => {
    const list = array(az(args, `${type} discovery failed; cleanup stopped.`), `${type} inventory`);
    for (const item of list) {
      requireEvidence(object(item) && nonblank(item.name) && typeof item.id === 'string' &&
        typeof item.type === 'string' && item.type.toLowerCase() === type.toLowerCase() &&
        typeof item.resourceGroup === 'string' && item.resourceGroup.toLowerCase() === resourceGroup &&
        /^[a-z0-9][a-z0-9-]*$/.test(item.name) &&
        new RegExp(`^/subscriptions/${guid}/resourceGroups/${resourceGroup}/providers/${type.replaceAll('.', '\\.')}/${item.name}$`, 'i').test(item.id) &&
        (type !== 'Microsoft.Storage/storageAccounts' || /^[a-z0-9]{3,24}$/.test(item.name)),
      `Incomplete ${type} inventory; cleanup stopped.`);
    }
    unique(list.map(item => item.id.toLowerCase()), `${type} inventory`);
    unique(list.map(item => item.name), `${type} names`);
    return list;
  };
  const endpoints = template => {
    requireEvidence(Array.isArray(template?.containers) && template.containers.length > 0,
      'Incomplete app/revision container inventory; cleanup stopped.');
    return template.containers.map(container => {
      requireEvidence(object(container) && Array.isArray(container.env) &&
        container.env.every(entry => object(entry) && nonblank(entry.name)),
      'Incomplete app/revision environment inventory; cleanup stopped.');
      const settings = container.env.filter(entry => entry.name.toLowerCase().startsWith('identity__'));
      unique(settings.map(entry => entry.name.toLowerCase()), 'app/revision identity settings');
      const setting = name => settings.find(entry => entry.name.toLowerCase() === name);
      const provider = setting('identity__provider');
      const endpoint = setting('identity__tableendpoint');
      const table = setting('identity__tablename');
      requireEvidence(provider?.value === 'AzureTable' && !provider.secretRef &&
        nonblank(endpoint?.value) && !endpoint.secretRef && nonblank(table?.value) && !table.secretRef,
      'Incomplete or indirect app/revision identity configuration; cleanup stopped.');
      return tableEndpoint(endpoint.value);
    });
  };
  const apps = () => resources(['containerapp', 'list'], 'Microsoft.App/containerApps').map(app => {
    requireEvidence(app.properties?.configuration?.activeRevisionsMode === 'Single' &&
      nonblank(app.properties.latestRevisionName),
    'Incomplete or unsupported app revision configuration; cleanup stopped.');
    const references = endpoints(app.properties.template);
    const revisions = array(az(['containerapp', 'revision', 'list', '--name', app.name, '--all'],
      'App revision discovery failed; cleanup stopped.'), 'App revision inventory');
    requireEvidence(revisions.every(revision => object(revision) && nonblank(revision.name) &&
      typeof revision.properties?.active === 'boolean' && typeof revision.id === 'string' &&
      revision.id.toLowerCase() === `${app.id}/revisions/${revision.name}`.toLowerCase()) &&
      revisions.some(revision => revision.name === app.properties.latestRevisionName) &&
      revisions.some(revision => revision.properties.active),
    'Incomplete app revision inventory; cleanup stopped.');
    unique(revisions.map(revision => revision.name), 'app revision inventory');
    for (const revision of revisions.filter(revision => revision.properties.active)) {
      references.push(...endpoints(revision.properties.template));
    }
    return { ...app, references: [...new Set(references)].sort() };
  });
  const stores = () => resources(['storage', 'account', 'list'], 'Microsoft.Storage/storageAccounts');
  const snapshot = () => {
    const accounts = stores();
    const deployments = apps();
    requireEvidence(new Set([...accounts, ...deployments].map(item => item.id.split('/')[2].toLowerCase())).size <= 1,
      'Ambiguous inventory subscription scopes; cleanup stopped.');
    // Read remote heads last to minimize the branch-recreation window.
    return { accounts, deployments, ...branches() };
  };
  const appEnvironment = app => {
    const environment = app.name.slice(appPrefix.length);
    return app.name.startsWith(appPrefix) && branchEnvironment(environment) &&
      object(app.tags) && app.tags['azd-env-name'] === environment &&
      app.properties.provisioningState === 'Succeeded' &&
      app.identity?.type === 'SystemAssigned' && new RegExp(`^${guid}$`, 'i').test(app.identity.principalId)
      ? environment : null;
  };
  const storeEnvironment = account => {
    const tags = account.tags;
    if (!object(tags) || tags['astervoids-data'] !== 'player-identity' ||
      tags['astervoids-deployment-kind'] !== 'branch' ||
      !['branch-orphan', 'manual'].includes(tags['astervoids-retention']) ||
      !branchEnvironment(tags['azd-env-name'])) return null;
    // manual on legacy branch stores predates the disposable-preview policy;
    // it is intentionally eligible, not an explicit keep override.
    requireEvidence(account.provisioningState === 'Succeeded' && nonblank(account.creationTime) &&
      Number.isFinite(Date.parse(account.creationTime)) && /^[a-z0-9]{3,24}$/.test(account.name),
    'Incomplete branch storage metadata; cleanup stopped.');
    requireEvidence(tableEndpoint(account.primaryEndpoints?.table) ===
      `https://${account.name}.table.core.windows.net`, 'Inconsistent branch storage endpoint; cleanup stopped.');
    return tags['azd-env-name'];
  };
  const appStamp = app => JSON.stringify([app.id, app.tags, app.identity, app.properties.latestRevisionName, app.references]);
  const storeStamp = store => JSON.stringify([store.id, store.tags, store.creationTime, store.primaryEndpoints?.table]);
  const skip = reason => log(`Safe skip: ${reason}.`);
  const names = (args, description) => {
    const list = array(az([...args, '--query', '[].name'], `${description} discovery failed; cleanup stopped.`), description);
    requireEvidence(list.every(name => nonblank(name) && !/\s/.test(name)), `Incomplete ${description}; cleanup stopped.`);
    unique(list, description);
    return list;
  };
  const activeSuffixes = () => {
    const currentApps = apps();
    const active = branches().suffixes;
    for (const app of currentApps) {
      if (app.name.startsWith(appPrefix)) {
        const suffix = app.name.slice(appPrefix.length);
        active.add(suffix);
        if (suffix.startsWith('production-')) active.add(suffix.slice('production-'.length));
      }
    }
    return active;
  };
  const cleanupDns = (domain, subdomain) => {
    if (!domain && !subdomain) return 0;
    requireEvidence(nonblank(domain) && nonblank(subdomain), 'Partial custom-domain configuration; DNS cleanup stopped.');
    const targets = [];
    for (const kind of ['cname', 'txt']) {
      const prefix = `${kind === 'txt' ? 'asuid.' : ''}${subdomain}-`;
      for (const name of names(['network', 'dns', 'record-set', kind, 'list', '--zone-name', domain], 'DNS inventory')) {
        if (name.startsWith(prefix)) targets.push({
          suffix: name.slice(prefix.length),
          args: ['network', 'dns', 'record-set', kind, 'delete', '--zone-name', domain, '--name', name, '--yes']
        });
      }
    }
    const domainSuffix = `-${domain.replaceAll('.', '-')}`;
    for (const environment of names(['containerapp', 'env', 'list'], 'Container environment inventory')
      .filter(name => name === environmentPrefix || name.startsWith(`${environmentPrefix}-`))) {
      for (const name of names(['containerapp', 'env', 'certificate', 'list', '--name', environment], 'Certificate inventory')) {
        const prefix = `cert-${subdomain}-`;
        if (name.startsWith(prefix) && name.endsWith(domainSuffix) && name !== `cert-${subdomain}${domainSuffix}`) {
          targets.push({
            suffix: name.slice(prefix.length, -domainSuffix.length),
            args: ['containerapp', 'env', 'certificate', 'delete', '--name', environment, '--certificate', name, '--yes']
          });
        }
      }
    }
    let deleted = 0;
    for (const target of targets) {
      if (!branchEnvironment(target.suffix) || protectedSuffix(target.suffix, activeSuffixes())) continue;
      az(target.args, 'DNS/certificate deletion failed; cleanup stopped.', 'none');
      deleted++;
    }
    return deleted;
  };

  return {
    verifyDeploymentRef(ref, sha) {
      const current = branches().refs;
      const branch = typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
      requireEvidence(current.has(branch) && current.get(branch) === sha,
        'Deployment ref was removed or superseded while queued; refusing to deploy.');
    },
    cleanup({ domain = '', subdomain = '' } = {}) {
      const initial = snapshot();
      // Validate all candidate metadata before making any destructive call.
      const candidates = initial.accounts.map(account => ({ account, environment: storeEnvironment(account) }));
      const result = { apps: 0, stores: 0, dns: 0 };
      for (const original of initial.deployments) {
        const environment = appEnvironment(original);
        if (!environment) {
          skip('app ownership or readiness could not be established');
          continue;
        }
        if (protectedSuffix(environment, initial.suffixes)) continue;
        const current = snapshot();
        const app = current.deployments.find(item => item.id.toLowerCase() === original.id.toLowerCase());
        if (!app) continue;
        if (appEnvironment(app) !== environment || appStamp(app) !== appStamp(original) ||
          protectedSuffix(environment, current.suffixes)) {
          skip('branch/app changed during revalidation');
          continue;
        }
        az(['containerapp', 'delete', '--name', app.name, '--yes'], 'App deletion failed; storage retained.', 'none');
        requireEvidence(!apps().some(item => item.name === app.name),
          'App deletion was not confirmed absent; storage retained.');
        result.apps++;
        log('Deleted an orphan branch app and confirmed its absence.');
      }
      // This pass also runs with zero apps: older orphaned stores need no
      // redeploy or surviving app to become eligible.
      for (const { account: original, environment } of candidates) {
        if (!environment) {
          skip('store is not explicitly owned by a disposable branch');
          continue;
        }
        const current = snapshot();
        const account = current.accounts.find(item => item.id.toLowerCase() === original.id.toLowerCase());
        if (!account) continue;
        if (storeEnvironment(account) !== environment || storeStamp(account) !== storeStamp(original) ||
          protectedSuffix(environment, current.suffixes)) {
          skip('store/branch is protected or changed during revalidation');
          continue;
        }
        if (current.accounts.filter(item => object(item.tags) && item.tags['azd-env-name'] === environment).length !== 1) {
          skip('storage ownership is ambiguous');
          continue;
        }
        const endpoint = tableEndpoint(account.primaryEndpoints.table);
        if (current.deployments.some(app => app.name === `${appPrefix}${environment}` ||
          app.tags?.['azd-env-name'] === environment || app.references.includes(endpoint))) {
          skip('a remaining deployment or active revision may use this store');
          continue;
        }
        az(['storage', 'account', 'delete', '--name', account.name, '--yes'], 'Storage deletion failed; retry required.', 'none');
        requireEvidence(!stores().some(item => item.name === account.name),
          'Storage deletion was not confirmed absent; retry required.');
        result.stores++;
        log('Permanently deleted an orphan branch identity/leaderboard store and confirmed its absence.');
      }
      result.dns = cleanupDns(domain, subdomain);
      return result;
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runner = createCleanup();
    if (process.argv[2] === '--verify-deployment-ref') {
      runner.verifyDeploymentRef(process.env.GITHUB_REF, process.env.GITHUB_SHA);
    } else {
      requireEvidence(process.argv.length === 2, 'Unsupported cleanup arguments.');
      const result = runner.cleanup({ domain: process.env.CUSTOM_DOMAIN_NAME, subdomain: process.env.CUSTOM_SUBDOMAIN });
      const summary = `Orphan cleanup: deleted ${result.apps} apps, ${result.stores} disposable identity/leaderboard stores, and ${result.dns} DNS/certificate artifacts.`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
