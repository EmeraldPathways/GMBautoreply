import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {environment} from './d1.mjs';
import {one, run, loadSettings, putSettings} from '../src/data.js';
import {sealToken} from '../src/security.js';
const base = 'https://desk.example';
const request = (path, method = 'GET', body, cookie, origin = base) => new Request(base + path, {method, headers: {'Origin': origin, 'Content-Type': 'application/json', ...(cookie && {Cookie: cookie})}, ...(body !== undefined && {body: JSON.stringify(body)})});

test('hosted sign-in guards private state and mutating actions', async () => {
  const env = environment();
  assert.equal((await worker.fetch(request('/api/state'), env)).status, 401);
  const loginPage = await worker.fetch(request('/'), env);
  assert.match(await loginPage.text(), /Sign in/);
  const wrong = await worker.fetch(request('/login', 'POST', {password: 'wrong'}), env);
  assert.equal(wrong.status, 401);
  const login = await worker.fetch(request('/login', 'POST', {password: env.ADMIN_PASSWORD}), env);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.match(login.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
  assert.equal((await worker.fetch(request('/api/state', 'GET', undefined, cookie), env)).status, 200);
  assert.equal((await worker.fetch(request('/api/sample', 'POST', {}, cookie, 'https://attacker.example'), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/sample', 'POST', {}, cookie), env)).status, 200);
  const data = await (await worker.fetch(request('/api/state', 'GET', undefined, cookie), env)).json();
  assert.equal(data.reviews.filter(x => x.demo).length, 4);
  const logout = await worker.fetch(request('/logout', 'POST', {}, cookie), env);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
});
test('private Sites requests rely on the platform user header', async () => {
  const env = environment({SITES_PRIVATE_AUTH: '1'});
  delete env.ADMIN_PASSWORD;
  delete env.SESSION_SECRET;
  assert.equal((await worker.fetch(request('/api/state'), env)).status, 401);
  const signed = new Request(base + '/api/state', {headers: {'oai-authenticated-user-id': 'site-owner'}});
  assert.equal((await worker.fetch(signed, env)).status, 200);
});
test('Google callback needs the originating signed session and state', async () => {
  const env = environment({GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret'});
  const login = await worker.fetch(request('/login', 'POST', {password: env.ADMIN_PASSWORD}), env);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const start = await (await worker.fetch(request('/api/oauth/start', 'GET', undefined, cookie), env)).json();
  const url = new URL(start.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const state = url.searchParams.get('state');
  assert.equal((await worker.fetch(request(`/oauth/callback?state=${state}&code=a`), env)).status, 401);
  assert.equal((await worker.fetch(request('/oauth/callback?state=bad&code=a', 'GET', undefined, cookie), env)).status, 400);
});
test('unsigned push notifications are rejected', async () => {
  const env = environment({PUSH_AUDIENCE: base + '/webhooks/pubsub', PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.com'});
  assert.equal((await worker.fetch(request('/webhooks/pubsub', 'POST', {message: {data: 'e30='}}), env)).status, 401);
});
test('scheduled work drafts new reviews, publishes at most the daily cap, and does not repeat', async () => {
  const loc = 'accounts/1/locations/2';
  const replies = new Map();
  const reviews = [3, 4].map(n => ({name: `${loc}/reviews/${n}`, reviewer: {displayName: 'Customer'}, starRating: 'FIVE', comment: 'Lovely clean', createTime: new Date().toISOString(), updateTime: new Date().toISOString()}));
  let puts = 0;
  const env = environment({GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPENAI_API_KEY: 'openai', __fetch: async (url, options) => {
    const path = String(url);
    if (path.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({access_token: 'access'}));
    if (path.includes('api.openai.com')) return new Response(JSON.stringify({status: 'completed', output: [{content: [{type: 'output_text', text: JSON.stringify({reply: 'Thank you for visiting.', needs_review: false, reason: '', theme: 'cleanliness'})}]}]}));
    if (path.endsWith('/reply')) {puts++; const id = path.replace('https://mybusiness.googleapis.com/v4/', '').replace('/reply', ''); replies.set(id, 'Thank you for visiting.'); return new Response(JSON.stringify({updateTime: new Date().toISOString()}));}
    if (path.endsWith('/reviews?pageSize=50')) return new Response(JSON.stringify({reviews: reviews.map(r => replies.has(r.name) ? {...r, reviewReply: {comment: replies.get(r.name), updateTime: new Date().toISOString()}} : r)}));
    const r = reviews.find(x => path.endsWith(x.name));
    if (r) return new Response(JSON.stringify(r));
    throw Error(`Unexpected provider URL: ${path}`);
  }});
  await run(env, 'INSERT INTO secrets(name,value) VALUES(?,?)', 'google_refresh', await sealToken('refresh', env));
  await run(env, 'INSERT INTO locations(name,title,account,enabled,seen) VALUES(?,?,?,?,?)', loc, 'Shop', 'accounts/1', 1, Date.now());
  const s = await loadSettings(env);
  Object.assign(s, {auto_mode: 'publish', publish_consent: true, auto_since: Date.now() - 10000, delay_minutes: 0, limit: 1, timezone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59'});
  await putSettings(env, s);
  await worker.scheduled({}, env);
  assert.equal(puts, 1);
  assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reviews WHERE status='published'")).n, 1);
  assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reviews WHERE status='draft'")).n, 1);
  await worker.scheduled({}, env);
  assert.equal(puts, 1);
});
test('signed Pub/Sub review event fetches only a selected location', async () => {
  const loc = 'accounts/1/locations/2', id = `${loc}/reviews/3`;
  const {publicKey, privateKey} = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
  const jwk = {...await crypto.subtle.exportKey('jwk', publicKey), kid: 'push-test'};
  const env = environment({GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUSH_AUDIENCE: base + '/webhooks/pubsub', PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.com', __fetch: async url => {
    const path = String(url);
    if (path.endsWith('/certs')) return new Response(JSON.stringify({keys: [jwk]}));
    if (path.endsWith('/token')) return new Response(JSON.stringify({access_token: 'access'}));
    if (path.endsWith(id)) return new Response(JSON.stringify({name: id, starRating: 'FIVE', comment: 'Great visit', createTime: new Date().toISOString(), updateTime: new Date().toISOString()}));
    throw Error('Unexpected provider request');
  }});
  await run(env, 'INSERT INTO secrets(name,value) VALUES(?,?)', 'google_refresh', await sealToken('refresh', env));
  await run(env, 'INSERT INTO locations(name,title,account,enabled,seen) VALUES(?,?,?,?,?)', loc, 'Shop', 'accounts/1', 0, Date.now());
  const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const head = b64({alg: 'RS256', kid: 'push-test'}), now = Math.floor(Date.now() / 1000);
  const payload = b64({iss: 'https://accounts.google.com', aud: env.PUSH_AUDIENCE, email: env.PUSH_SERVICE_ACCOUNT, email_verified: true, iat: now, exp: now + 3600});
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${payload}`))).toString('base64url');
  const body = {message: {data: Buffer.from(JSON.stringify({notificationType: 'NEW_REVIEW', locationName: loc, reviewName: id})).toString('base64')}};
  const req = () => new Request(base + '/webhooks/pubsub', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${head}.${payload}.${sig}`}, body: JSON.stringify(body)});
  assert.equal((await worker.fetch(req(), env)).status, 204);
  assert.equal(await one(env, 'SELECT id FROM reviews WHERE id=?', id), null);
  await run(env, 'UPDATE locations SET enabled=1 WHERE name=?', loc);
  assert.equal((await worker.fetch(req(), env)).status, 204);
  assert.equal((await one(env, 'SELECT text FROM reviews WHERE id=?', id)).text, 'Great visit');
});
