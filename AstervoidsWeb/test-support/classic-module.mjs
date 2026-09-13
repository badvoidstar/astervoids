/**
 * Loader for the classic-script modules under `wwwroot/js/`.
 *
 * Those modules are plain `<script>` files that resolve their dependencies
 * from script-level lexical scope (falling back to `require` under Node), so
 * tests have to evaluate them with the dependencies supplied as scope
 * variables. This helper centralises that evaluation:
 *
 *  - shared, dependency-free modules (debug logging) are injected once here,
 *    so a new shared dependency does not have to be threaded through every
 *    test file;
 *  - `compileFunction` keeps the real file name in stack traces;
 *  - callers pass only the stubs that are specific to their scenario, and may
 *    override an injected default by supplying the same key.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';

const require = createRequire(import.meta.url);

// Shared dependencies every classic-script module may reference.
const SHARED_GLOBALS = {
    AstervoidsDebugLog: require('../wwwroot/js/debug-log.js')
};

/**
 * Evaluates `wwwroot/js/<fileName>` and returns the named top-level binding
 * (the module's IIFE result), e.g. `ObjectSync` from `object-sync.js`.
 */
export function loadClassicModule(fileName, exportName, globals = {}) {
    const filename = fileURLToPath(new URL(`../wwwroot/js/${fileName}`, import.meta.url));
    const source = readFileSync(filename, 'utf8');
    const scope = { ...SHARED_GLOBALS, ...globals };
    return compileFunction(
        `${source}\nreturn ${exportName};`,
        Object.keys(scope),
        { filename }
    )(...Object.values(scope));
}
