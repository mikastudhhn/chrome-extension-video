import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Stable per checkout, so an already loaded extension reconnects after npm run dev restarts.
export async function helperSettings(directory) {
  const path = `${dirname(directory)}/helper.json`;
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const settings = { origin: `http://127.0.0.1:${port}`, token: randomBytes(32).toString('hex') };
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, JSON.stringify(settings), { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return JSON.parse(await readFile(path, 'utf8'));
  }
  return settings;
}

export async function startHelper(settings) {
  let state = { state: 'building', branch: null, buildId: null, error: '' };
  const url = new URL(settings.origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Dev-Helfer benötigt eine lokale Adresse.');
  const server = createServer((request, response) => {
    // No CORS, file serving, or remote actions. Only the generated dev build knows the token.
    if (request.headers.host !== url.host || request.headers.authorization !== `Bearer ${settings.token}` ||
        (request.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin))) {
      response.writeHead(403).end(); return;
    }
    if (request.method !== 'GET' || request.url !== '/status') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(state));
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port), '127.0.0.1', resolve); });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('Der Dev-Port ist belegt. Läuft npm run dev für diesen Checkout bereits?');
    throw error;
  }
  return {
    update(next) { state = { ...state, ...next }; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
