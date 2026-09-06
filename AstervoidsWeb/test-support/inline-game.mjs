import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFunction, Script } from 'node:vm';

const filename = fileURLToPath(new URL('../wwwroot/index.html', import.meta.url));
const source = readFileSync(filename, 'utf8');

function declarationSource(name) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
        throw new TypeError(`Invalid declaration name: ${name}`);
    }
    const escapedName = name.replace(/\$/g, '\\$');
    const match = new RegExp(
        `^\\s*(?:(?:async\\s+)?function|class)\\s+${escapedName}(?![\\w$])`, 'm')
        .exec(source);
    if (!match) throw new Error(`Missing inline game declaration: ${name}`);

    // Let the JS parser identify the complete declaration, including nested
    // blocks, default arguments, comments, and braces inside strings/templates.
    for (let end = source.indexOf('}', match.index); end !== -1;
        end = source.indexOf('}', end + 1)) {
        const candidate = source.slice(match.index, end + 1);
        try {
            new Script(`(${candidate}\n)`, { filename });
            return candidate;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    throw new Error(`Incomplete inline game declaration: ${name}`);
}

// Compile only the requested production declarations; never boot the DOM,
// transport, or frame loop. Dependencies remain explicit in each test.
export function loadInlineGameFunctions(names, globals = {}) {
    const declarations = names.map(declarationSource).join('\n');
    return compileFunction(
        `${declarations}\nreturn { ${names.join(', ')} };`,
        Object.keys(globals),
        { filename }
    )(...Object.values(globals));
}
