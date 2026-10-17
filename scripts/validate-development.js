import { validateResources } from './validate-resources.js';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SourceTextModule } from 'node:vm';

const root = resolve(process.argv[2]);
await validateResources(root);
const modules = new Map();
const files = await readdir(root, { recursive: true });
for (const file of files) {
  const path = resolve(root, file);
  if (file.endsWith('.js')) modules.set(path, new SourceTextModule(await readFile(path, 'utf8'), { identifier: file }));
  if (file.endsWith('.json')) JSON.parse(await readFile(path, 'utf8'));
  if (file.endsWith('.html')) {
    const html = await readFile(path, 'utf8');
    for (const [, resource] of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
      if (!/^[a-z]+:/i.test(resource)) await readFile(resolve(dirname(path), resource));
    }
  }
}
for (const module of modules.values()) {
  if (module.status !== 'unlinked') continue;
  await module.link((specifier, parent) => {
    const dependency = modules.get(resolve(root, dirname(parent.identifier), specifier));
    if (!specifier.startsWith('.') || !dependency) throw new Error(`Fehlender Import: ${parent.identifier} → ${specifier}`);
    return dependency;
  });
}
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.name || !/^\d+(\.\d+){0,3}$/.test(manifest.version) ||
    manifest.version.split('.').some(part => Number(part) > 65535) || !manifest.version.split('.').some(Number)) throw new Error('Ungültiges Manifest.');
await readFile(resolve(root, manifest.background.service_worker));
await readFile(resolve(root, manifest.action.default_popup));
