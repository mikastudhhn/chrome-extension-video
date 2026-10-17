// Design-system guard: stylesheets outside tokens.css must not introduce raw
// colours or ad-hoc pixel sizes. Lines that need a raw value carry `/* px-ok */`.
import { readdir, readFile } from 'node:fs/promises';

export async function checkDesignTokens(directory = 'extension') {
  const problems = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.css') && name !== 'tokens.css').sort()) {
    const css = await readFile(`${directory}/${file}`, 'utf8');
    let line = 0;
    for (const text of css.split('\n')) {
      line++;
      if (text.includes('px-ok')) continue;
      // Only declaration values: strip selectors before "{" and at-rule preludes.
      const values = text.replace(/^[^{]*\{/, '').replace(/@media[^{]*/g, '');
      if (/#[0-9a-f]{3,8}\b/i.test(values) || /\b(?:rgba?|hsla?)\(/.test(values)) problems.push(`${file}:${line}: raw colour, use a --color-* token`);
      for (const [, size] of values.matchAll(/(-?\d*\.?\d+)px\b/g)) {
        if (Math.abs(Number(size)) >= 4) { problems.push(`${file}:${line}: raw size ${size}px, use a --space-*/--size-* token`); break; }
      }
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = await checkDesignTokens(process.argv[2]);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('Design tokens: stylesheets use semantic tokens only.');
}
