import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

// Runtime URLs are deliberately literal and local. Module linking is additionally
// checked by validate-development.js; these checks include non-import resources.
export async function validateResources(directory, extensionRoot = directory) {
  const root = resolve(extensionRoot);
  const requireFile = async (from, resource, base) => {
    const path = resolve(base, resource);
    if (!path.startsWith(root + sep)) throw new Error(`Ungültiger Ressourcenpfad: ${from} → ${resource}`);
    try { await readFile(path); }
    catch { throw new Error(`Fehlende Laufzeitdatei: ${from} → ${resource}`); }
  };
  for (const file of await readdir(directory, { recursive: true })) {
    if (!/\.(?:js|html)$/.test(file)) continue;
    const path = resolve(directory, file), source = await readFile(path, 'utf8');
    if (file.endsWith('.html')) {
      for (const [, resource] of source.matchAll(/(?:src|href)=["']([^"'#]+\.(?:js|css))["']/g)) await requireFile(file, resource, dirname(path));
      continue;
    }
    for (const [, resource] of source.matchAll(/\b(?:import\s*(?:\([^)]*?['"]|['"])|(?:import|export)\s+[^;]*?\bfrom\s*['"])([^'"]+)['"]/g)) {
      if (!resource.startsWith('./')) throw new Error(`Nicht lokaler Modulimport: ${file} → ${resource}`);
      await requireFile(file, resource, dirname(path));
    }
    for (const [, resource] of source.matchAll(/(?:new\s+Worker|\.addModule)\(\s*['"]([^'"]+)['"]/g)) await requireFile(file, resource, dirname(path));
    for (const [, list] of source.matchAll(/\bfiles:\s*\[([^\]]+)\]/g)) {
      for (const [, resource] of list.matchAll(/['"]([^'"]+)['"]/g)) await requireFile(file, resource, root);
    }
  }
}
