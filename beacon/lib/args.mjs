import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const here = dirname(dirname(fileURLToPath(import.meta.url))); // beacon/

const OPTS = {
  web: { type: 'string', env: 'BEACON_WEB', help: 'directory with the console files (default: ../web next to beacon/)' },
  'https-port': { type: 'string', env: 'BEACON_HTTPS_PORT', help: 'https + websocket port (default 8443)' },
  'http-port': { type: 'string', env: 'BEACON_HTTP_PORT', help: 'plain http port for the CA install page (default 8080)' },
  data: { type: 'string', env: 'BEACON_DATA', help: 'where keys and certificates live (default: ./beacon-data inside beacon/)' },
  password: { type: 'string', env: 'BEACON_PASSWORD', help: 'require this password in the websocket hello' },
  tiles: { type: 'string', env: 'BEACON_TILES', help: 'serve /tiles/{z}/{x}/{y}.png from this directory' },
  name: { type: 'string', env: 'BEACON_NAME', help: 'room name shown to clients (default: beacon)' },
  host: { type: 'string', env: 'BEACON_HOST', help: 'address to bind (default 0.0.0.0)' },
  'dev-http': { type: 'string', env: 'BEACON_DEV_HTTP', help: 'ALSO serve web/ and the hub over plain http on 127.0.0.1:PORT (local testing only)' },
  'host-name': { type: 'string', multiple: true, env: 'BEACON_HOST_NAME', help: 'extra name or address to put in the certificate (repeatable; env: comma separated)' },
  help: { type: 'boolean', short: 'h' },
};

export function usage() {
  const lines = ['usage: node server.mjs [options]', ''];
  for (const [k, o] of Object.entries(OPTS)) {
    if (!o.help) continue;
    lines.push(`  --${k.padEnd(12)} ${o.help}${o.env ? ` [${o.env}]` : ''}`);
  }
  lines.push('', 'relative paths given on the command line are resolved against the current directory.');
  return lines.join('\n');
}

function port(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--${name} must be a port number, got ${JSON.stringify(v)}`);
  return n;
}

function dir(p, name) {
  try {
    if (statSync(p).isDirectory()) return p;
  } catch {
    // fall through
  }
  throw new Error(`--${name}: ${p} is not a directory`);
}

// argv wins over env; env wins over defaults. throws on bad input.
export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const options = Object.fromEntries(Object.entries(OPTS).map(([k, o]) => [k, { type: o.type, ...(o.multiple && { multiple: true }), ...(o.short && { short: o.short }) }]));
  const { values } = parseArgs({ args: argv, options, allowPositionals: false });
  const get = (k) => {
    if (values[k] !== undefined) return values[k];
    const e = env[OPTS[k].env];
    if (e === undefined || e === '') return undefined;
    return OPTS[k].multiple ? e.split(',') : e;
  };
  if (values.help) return { help: true };
  const web = get('web') ? resolve(get('web')) : resolve(here, '../web');
  const data = get('data') ? resolve(get('data')) : resolve(here, 'beacon-data');
  const tiles = get('tiles') ? dir(resolve(get('tiles')), 'tiles') : null;
  return {
    web: dir(web, 'web'),
    data,
    tiles,
    httpsPort: port(get('https-port') ?? 8443, 'https-port'),
    httpPort: port(get('http-port') ?? 8080, 'http-port'),
    devHttp: get('dev-http') ? port(get('dev-http'), 'dev-http') : null,
    password: get('password') || '',
    name: get('name') || 'beacon',
    host: get('host') || '0.0.0.0',
    hostNames: (get('host-name') || []).map((s) => s.trim()).filter(Boolean),
  };
}
