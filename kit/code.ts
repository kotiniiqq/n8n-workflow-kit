/** codeNode(): turn a module from code/ into a Code node.
 *
 * n8n Code nodes cannot import each other, and their code lives in a JSON string nobody
 * tests. Here the logic is an ordinary module with unit tests; esbuild bundles it (shared
 * helpers included) into an IIFE, and a two-line wrapper calls it with n8n's globals.
 */
import { buildSync } from 'esbuild';
import { node } from '@n8n/workflow-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WRAPPER = `
return __kit.default($input.all(), {
  now: new Date().toISOString(),
  node: (name) => $(name).all(),
});`;

export function bundleCode(modulePath: string): string {
  const entry = path.isAbsolute(modulePath) ? modulePath : path.join(ROOT, modulePath);
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: '__kit',
    platform: 'neutral',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const banner = `// generated from ${path.relative(ROOT, entry).replace(/\\/g, '/')} by n8n-workflow-kit; edit the source, not this node`;
  return `${banner}\n${result.outputFiles[0].text.trim()}\n${WRAPPER.trim()}\n`;
}

export function codeNode(name: string, modulePath: string, position?: [number, number]) {
  return node({
    type: 'n8n-nodes-base.code',
    version: 2,
    config: { name, ...(position ? { position } : {}), parameters: { jsCode: bundleCode(modulePath) } },
  });
}
