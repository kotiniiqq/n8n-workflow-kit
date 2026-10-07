/** codeNode(): turn a module from code/ into a Code node.
 *
 * n8n Code nodes cannot import each other, and their code lives in a JSON string nobody
 * tests. Here the logic is an ordinary module with unit tests; esbuild bundles it (shared
 * helpers included) into an IIFE, and a two-line wrapper calls it with n8n's globals.
 *
 * The bundle hands the module's default export over by plain assignment, not through esbuild's
 * export object: n8n's task runner replaces Object.defineProperty with a no-op before running a
 * Code node, and esbuild defines exports with it, so `__kit.default` would be undefined there.
 */
import { buildSync } from 'esbuild';
import { node } from '@n8n/workflow-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WRAPPER = `
return __kitMain($input.all(), {
  now: new Date().toISOString(),
  node: (name) => $(name).all(),
});`;

export function bundleCode(modulePath: string): string {
  const entry = path.isAbsolute(modulePath) ? modulePath : path.join(ROOT, modulePath);
  const result = buildSync({
    stdin: {
      contents: `import main from ${JSON.stringify(entry.replace(/\\/g, '/'))};\n__kitMain = main;\n`,
      resolveDir: ROOT,
      sourcefile: 'kit-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const banner = `// generated from ${path.relative(ROOT, entry).replace(/\\/g, '/')} by n8n-workflow-kit; edit the source, not this node`;
  return `${banner}\nlet __kitMain;\n${result.outputFiles[0].text.trim()}\n${WRAPPER.trim()}\n`;
}

export function codeNode(name: string, modulePath: string, position?: [number, number]) {
  return node({
    type: 'n8n-nodes-base.code',
    version: 2,
    config: { name, ...(position ? { position } : {}), parameters: { jsCode: bundleCode(modulePath) } },
  });
}
