/** Prepare a throwaway n8n for `npm run e2e`: create the owner account and an API key.
 *  Uses n8n's internal REST endpoints (/rest/...), the same calls the setup screen makes.
 *
 *   npm run e2e:setup        # prints the export line for N8N_API_KEY_LOCAL
 */
const BASE = process.env.N8N_URL ?? 'http://localhost:5678';
const owner = { email: 'owner@example.com', firstName: 'Kit', lastName: 'E2E', password: 'KitTest-12345' };
const json = { 'content-type': 'application/json' };

async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

const setup = await fetch(`${BASE}/rest/owner/setup`, { method: 'POST', headers: json, body: JSON.stringify(owner) });
if (!setup.ok && setup.status !== 400) throw new Error(`owner setup -> ${setup.status}`); // 400: owner exists already
const login = await call('/rest/login', { method: 'POST', headers: json, body: JSON.stringify({ emailOrLdapLoginId: owner.email, password: owner.password }) });
const headers = { ...json, cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), 'browser-id': 'n8n-kit-e2e' };
const scopes = (await (await call('/rest/api-keys/scopes', { headers })).json()).data;
const key = await call('/rest/api-keys', { method: 'POST', headers, body: JSON.stringify({ label: `kit-e2e-${Date.now()}`, scopes, expiresAt: null }) });
console.log(`export N8N_API_KEY_LOCAL=${(await key.json()).data.rawApiKey}`);
