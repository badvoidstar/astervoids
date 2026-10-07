import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const sources = ['game-config.js', 'player-identity.js', 'astervoids-wire-codec.js']
    .map(name => readFileSync(new URL(`./wwwroot/js/${name}`, import.meta.url), 'utf8'));

function browserConfiguration(configuration) {
    const context = createContext({
        ASTERVOIDS_SHARED_CONFIG: configuration,
        GuidUtils: require('./wwwroot/js/guid-utils.js'),
        Uint8Array, DataView,
    });
    for (const source of sources) runInContext(source, context);
    return runInContext('({ config: AstervoidsConfig, identity: PlayerIdentity, wire: AstervoidsWireCodec })', context);
}

test('generated settings load before their consumers without delaying invitation capture', () => {
    const html = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    assert.equal(scripts[0], '/js/player-identity.js');
    const bootstrap = scripts.indexOf('/region-bootstrap.js');
    const transport = scripts.indexOf('/js/signalr.min.js');
    assert.ok(bootstrap > 0 && bootstrap < transport);
    assert.equal(scripts.filter(script => script === '/region-bootstrap.js').length, 1);
    const preparation = html.indexOf('PlayerIdentity.prepareRegion()');
    assert.ok(preparation > html.indexOf('<script src="/region-bootstrap.js"')
        && preparation < html.indexOf('<script src="/js/signalr.min.js"'));
    const data = scripts.indexOf('/js/shared-config-data.js');
    const config = scripts.indexOf('/js/game-config.js');
    const wire = scripts.indexOf('/js/astervoids-wire-codec.js');
    assert.ok(data > 0 && data < config && config < wire);
});

for (const maximum of [1, 6, 12, 255]) {
    test(`the shared ${maximum}-character limit controls identity validation and tag packing`, () => {
        const { config, identity, wire } = browserConfiguration({ identityTagMaxLength: maximum });
        assert.equal(config.IDENTITY_TAG_MAX_LENGTH, maximum);
        assert.equal(identity.TAG_PATTERN, config.IDENTITY_TAG_PATTERN);
        const tag = 'A'.repeat(maximum);
        assert.equal(identity.TAG_PATTERN.test(tag), true);
        assert.equal(identity.TAG_PATTERN.test(`${tag}A`), false);
        assert.equal(wire.isParticipantTag(tag), true);
        assert.equal(wire.isParticipantTag(`${tag}A`), false);

        const id = '00112233-4455-6677-8899-aabbccddeeff';
        const packed = wire.packTagMap({ [id]: tag });
        assert.equal(packed[16], maximum);
        assert.equal(wire.unpackTagMap(packed)[id], tag);
        assert.throws(() => wire.packTagMap({ [id]: `${tag}A` }));
        const oversized = new Uint8Array(17 + maximum + 1);
        oversized.set(packed.subarray(0, 16));
        oversized[16] = maximum + 1;
        oversized.fill('A'.charCodeAt(0), 17);
        assert.throws(() => wire.unpackTagMap(oversized), /invalid/);
    });
}

for (const value of [undefined, null, {}, { identityTagMaxLength: 0 },
    { identityTagMaxLength: -1 }, { identityTagMaxLength: 1.5 },
    { identityTagMaxLength: 256 }, { identityTagMaxLength: '10' }]) {
    test(`invalid shared configuration is rejected instead of using a hidden default: ${JSON.stringify(value)}`, () => {
        assert.throws(() => browserConfiguration(value), /shared configuration|identityTagMaxLength/i);
    });
}

test('native identity entry and validation messages derive from a non-default shared limit', () => {
    const { config } = browserConfiguration({ identityTagMaxLength: 12 });
    const identityTagInput = {};
    const hint = {};
    const { configureIdentityTagInput, identityMessage } = loadInlineGameFunctions(
        ['configureIdentityTagInput', 'identityMessage'], {
            AstervoidsConfig: config, identityTagInput,
            document: { getElementById: () => hint },
        });
    configureIdentityTagInput();
    assert.equal(identityTagInput.maxLength, config.IDENTITY_TAG_MAX_LENGTH);
    assert.equal(identityTagInput.pattern, config.IDENTITY_TAG_PATTERN_SOURCE);
    assert.match(hint.textContent, /1-12/);
    assert.match(identityMessage({ code: 'invalid_tag' }), /1-12/);
    assert.equal(new RegExp(`^(?:${identityTagInput.pattern})$`, 'v').test('A_b-12345678'), true);
    assert.equal(new RegExp(`^(?:${identityTagInput.pattern})$`, 'v').test('A_b-123456789'), false);
    assert.equal(config.DEBUG_OVERRIDABLE_KEYS.includes('IDENTITY_TAG_MAX_LENGTH'), false);
    assert.equal(config.SESSION_CONFIG_KEYS.includes('IDENTITY_TAG_MAX_LENGTH'), false);
});
