import {DEFAULT, eligible, withinHours, localParts, notificationReview, validateSettings, REVIEW_NAME} from './core.js';
import {createSession, readSession, checkPassword, sealToken, unsealToken, verifyPushJWT} from './security.js';
import {one, all, run, audit, loadSettings, putSettings, purge, ingest, getReview, saveDraft, learn, state} from './data.js';
import {requestJSON, googleToken, discover, sync, generate, publish, configureNotifications} from './providers.js';
import {html} from './ui.js';

const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {status, headers: {...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra}});
const page = (body, status = 200) => new Response(body, {status, headers: {...headers, 'Content-Type': 'text/html; charset=utf-8'}});
const cookie = (value, maxAge = 43200) => `rd_session=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
function cookieValue(request) {return request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('rd_session='))?.slice(11) || '';}
function config(env) {
  if (!env.DB || !env.PUBLIC_BASE_URL || !/^https:\/\/[^/?#]+$/.test(env.PUBLIC_BASE_URL) || !env.TOKEN_KEY || (env.SITES_PRIVATE_AUTH !== '1' && ((env.ADMIN_PASSWORD || '').length < 32 || (env.SESSION_SECRET || '').length < 32))) throw Error('Hosted setup is incomplete. Configure D1, HTTPS URL and the required secrets.');
}
async function auth(request, env) {
  if (env.SITES_PRIVATE_AUTH === '1') return request.headers.get('oai-authenticated-user-id') || null;
  const id = await readSession(cookieValue(request), env);
  return id && await one(env, 'SELECT id FROM sessions WHERE id=? AND expires>?', id, Date.now()) ? id : null;
}
function sameOrigin(request, env) {return request.headers.get('Origin') === env.PUBLIC_BASE_URL;}
async function input(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw Error('Expected JSON.');
  const text = await request.text();
  if (text.length > 100000) throw Error('Request too large.');
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Expected a JSON object.');
  return data;
}
async function rateKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SESSION_SECRET}:${ip}`)));
  return [...bytes].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
}
const loginPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Review Desk</title><style>body{font:16px system-ui;background:#f1f7f8;color:#153849;display:grid;min-height:100vh;place-items:center;margin:0}.box{background:white;padding:36px;border-radius:18px;box-shadow:0 12px 48px #1234;max-width:390px;width:calc(100% - 64px)}h1{margin:0 0 8px}p{color:#567}input,button{font:inherit;width:100%;box-sizing:border-box;padding:13px;margin-top:16px;border-radius:9px}input{border:1px solid #9ab}button{background:#0d6d76;color:white;border:0;cursor:pointer}#error{color:#9a3024;min-height:1.5em}</style><main class="box"><h1>Review Desk</h1><p>Private hosted workspace</p><form id="login"><label for="password">Access password</label><input id="password" type="password" autocomplete="current-password" required><button>Sign in</button><p id="error" role="alert"></p></form></main><script>document.getElementById('login').onsubmit=async e=>{e.preventDefault();let b=e.target.querySelector('button');b.disabled=true;try{let r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});if(!r.ok)throw Error((await r.json()).error||'Sign in failed');location.href='/'}catch(x){document.getElementById('error').textContent=x.message;b.disabled=false}}</script></html>`;

async function login(request, env) {
  const key = await rateKey(request, env), attempts = await one(env, 'SELECT count,expires FROM login_attempts WHERE key=?', key);
  if (attempts && attempts.expires > Date.now() && attempts.count >= 10) return json({error: 'Too many attempts. Try again later.'}, 429);
  const data = await input(request);
  if (!await checkPassword(data.password, env.ADMIN_PASSWORD)) {
    await run(env, 'INSERT INTO login_attempts(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END', key, Date.now() + 15 * 60000, Date.now(), Date.now());
    return json({error: 'Incorrect password.'}, 401);
  }
  await run(env, 'DELETE FROM login_attempts WHERE key=?', key);
  const value = await createSession(env), sid = await readSession(value, env);
  await run(env, 'INSERT INTO sessions(id,expires) VALUES(?,?)', sid, Date.now() + 12 * 3600000);
  return json({ok: true}, 200, {'Set-Cookie': cookie(value)});
}
async function oauthStart(env, sid) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  const state = crypto.randomUUID(), verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await run(env, 'INSERT INTO oauth_states(state,verifier,session_id,expires) VALUES(?,?,?,?)', state, verifier, sid, Date.now() + 600000);
  const params = new URLSearchParams({client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.PUBLIC_BASE_URL}/oauth/callback`, response_type: 'code', scope: 'https://www.googleapis.com/auth/business.manage', access_type: 'offline', prompt: 'consent', state, code_challenge_method: 'S256', code_challenge: challenge});
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
async function oauthFinish(env, sid, url) {
  const state = url.searchParams.get('state') || '';
  const row = await one(env, 'SELECT * FROM oauth_states WHERE state=? AND session_id=? AND expires>?', state, sid, Date.now());
  if (!row) throw Error('Sign-in expired. Start again from Connections.');
  const deleted = await run(env, 'DELETE FROM oauth_states WHERE state=? AND session_id=?', state, sid);
  if (!deleted.meta.changes) throw Error('This sign-in was already used.');
  if (url.searchParams.get('error')) throw Error('Google sign-in was cancelled or rejected.');
  const code = url.searchParams.get('code');
  if (!code) throw Error('Google did not return a code.');
  const result = await requestJSON(env, 'https://oauth2.googleapis.com/token', {data: {client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, code_verifier: row.verifier, redirect_uri: `${env.PUBLIC_BASE_URL}/oauth/callback`, grant_type: 'authorization_code'}, form: true});
  if (!result.refresh_token) throw Error('No offline access was granted. Revoke this app in your Google Account and try again.');
  await run(env, 'INSERT INTO secrets(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value', 'google_refresh', await sealToken(result.refresh_token, env));
  const s = await loadSettings(env); s.auto_mode = 'off'; s.publish_consent = false; await putSettings(env, s);
  await audit(env, 'Google connected');
}
async function disconnect(env) {
  const s = await loadSettings(env); s.auto_mode = 'off'; s.publish_consent = false; await putSettings(env, s);
  const stored = await one(env, "SELECT value FROM secrets WHERE name='google_refresh'");
  if (stored) {
    const refresh = await unsealToken(stored.value, env);
    try {await requestJSON(env, 'https://oauth2.googleapis.com/revoke', {data: {token: refresh}, form: true});}
    catch (e) {if (e.status !== 400) throw Error('Google could not revoke access. Automation is off; retry disconnecting.');}
  }
  await run(env, "DELETE FROM secrets WHERE name='google_refresh'");
  await run(env, 'DELETE FROM reviews WHERE demo=0');
  await run(env, 'DELETE FROM locations');
  await audit(env, 'Google disconnected');
}
async function act(env, name, data) {
  if (name === 'settings') {
    const old = await loadSettings(env), s = validateSettings(old, data);
    if (old.auto_mode === 'off' && s.auto_mode !== 'off') {
      if (!env.OPENAI_API_KEY) throw Error('Add OPENAI_API_KEY before enabling automation.');
      await sync(env); s.auto_since = Date.now(); s.synced_at = s.auto_since;
    }
    await putSettings(env, s); await audit(env, 'settings saved');
  } else if (name === 'sample') {
    for (const [id, person, rating, body] of [['demo-1', 'Sarah M.', 5, 'First visit and the car came back spotless. John removed the stains brilliantly.'], ['demo-2', 'Michael', 4, 'Friendly team and a great clean.'], ['demo-3', 'Aoife', 2, 'Disappointed with the wait and the interior was still dirty.'], ['demo-4', 'Patrick', 5, '']]) {
      await run(env, "INSERT OR IGNORE INTO reviews(id,name,rating,text,demo,created,first_seen,source) VALUES(?,?,?,?,1,?,?,?)", id, person, rating, body, new Date().toISOString(), Date.now(), 'Sample');
    }
  } else if (name === 'discover') await discover(env);
  else if (name === 'sync') await sync(env);
  else if (name === 'notifications') await configureNotifications(env);
  else if (name === 'disconnect') await disconnect(env);
  else if (name === 'location') {
    if (!await one(env, 'SELECT 1 FROM locations WHERE name=?', data.name)) throw Error('Unknown location.');
    await run(env, 'UPDATE locations SET enabled=? WHERE name=?', data.enabled === true ? 1 : 0, data.name);
  } else if (name === 'example-add') {
    const original = data.original, reply = data.reply;
    if (typeof original !== 'string' || typeof reply !== 'string' || !reply.trim() || original.length > 5000 || reply.length > 4096) throw Error('Provide an example reply of at most 4096 characters.');
    await run(env, 'INSERT INTO examples(original,reply,created) VALUES(?,?,?)', original.trim(), reply.trim(), Date.now());
  } else if (name === 'example-delete') {
    if (!Number.isInteger(data.example_id)) throw Error('Invalid example.');
    await run(env, 'DELETE FROM examples WHERE id=? AND review_id IS NULL', data.example_id);
  } else if (['draft', 'save', 'approve', 'publish', 'simulate'].includes(name)) {
    const r = await getReview(env, data.id);
    if (name === 'draft') {
      if (['published', 'sample-replied', 'publishing'].includes(r.status)) throw Error('Published replies are read-only.');
      const result = await generate(env, r); await saveDraft(env, r.id, result.reply, 'draft', result.flag);
    } else if (name === 'save' || name === 'approve') {
      await saveDraft(env, r.id, data.draft, name);
      if (name === 'approve') await learn(env, r.id);
    } else if (name === 'publish') {
      if (r.draft !== data.draft) throw Error('Save and approve the current wording before publishing.');
      await publish(env, r);
    } else {
      if (!r.demo || r.status !== 'approved') throw Error('Approve a sample reply first.');
      await run(env, "UPDATE reviews SET status='sample-replied',published_at=? WHERE id=? AND status='approved'", new Date().toISOString(), r.id);
      await audit(env, 'sample replied', r.id);
    }
  } else throw Error('Unknown action.');
  return {ok: true};
}
async function autoTick(env, now = Date.now()) {
  const s = await loadSettings(env);
  if (s.auto_mode === 'off') return;
  if (s.auto_mode === 'publish' && !s.publish_consent) throw Error('Automatic publishing requires express consent.');
  await run(env, "UPDATE reviews SET status='new',processing_at=0 WHERE status='processing' AND processing_at<?", now - 20 * 60000);
  const due = await all(env, "SELECT * FROM reviews WHERE demo=0 AND status='new' AND first_seen>? AND first_seen<=? ORDER BY first_seen LIMIT 50", s.auto_since, now - s.delay_minutes * 60000);
  for (const r of due) {
    if (!eligible(r, s)) continue;
    if (s.auto_mode === 'publish' && !withinHours(s, now)) continue;
    const claim = await run(env, "UPDATE reviews SET status='processing',processing_at=? WHERE id=? AND status='new'", now, r.id);
    if (!claim.meta.changes) continue;
    try {
      const result = await generate(env, r);
      const drafted = await run(env, "UPDATE reviews SET draft=?,status='draft',flag=?,processing_at=0 WHERE id=? AND status='processing'", result.reply, result.flag, r.id);
      if (!drafted.meta.changes) continue;
      await audit(env, 'auto-drafted', r.id);
      if (s.auto_mode === 'publish' && !result.flag) {
        const current = await loadSettings(env), sendAt = Date.now();
        if (current.auto_mode !== 'publish' || !current.publish_consent || !eligible(r, current) || !withinHours(current, sendAt)) continue;
        const day = localParts(current, sendAt).date;
        await run(env, 'INSERT OR IGNORE INTO daily_budget(day,used) VALUES(?,0)', day);
        const reserve = await run(env, 'UPDATE daily_budget SET used=used+1 WHERE day=? AND used<?', day, current.limit);
        if (reserve.meta.changes) await publish(env, await getReview(env, r.id), true);
      }
    } catch (e) {
      await run(env, "UPDATE reviews SET status='new',processing_at=0 WHERE id=? AND status='processing'", r.id);
      await audit(env, 'automation failed', r.id, e.message);
    }
  }
}
async function push(request, env) {
  const bearer = request.headers.get('Authorization') || '';
  if (!bearer.startsWith('Bearer ')) return json({error: 'Authenticated Pub/Sub push required.'}, 401);
  try {await verifyPushJWT(bearer.slice(7), env, env.__fetch || fetch);}
  catch (e) {return json({error: 'Invalid push identity.'}, e.message.includes('unavailable') ? 503 : 401);}
  const body = await input(request);
  if (typeof body.message?.data !== 'string' || body.message.data.length > 100000) throw Error('Invalid Pub/Sub message.');
  const notification = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.message.data), x => x.charCodeAt(0))));
  const location = notification.locationName;
  const id = notificationReview(notification, location);
  if (!id) return new Response(null, {status: 204});
  if (!await one(env, 'SELECT 1 FROM locations WHERE name=? AND enabled=1', location)) return new Response(null, {status: 204});
  const token = await googleToken(env);
  const review = await requestJSON(env, `https://mybusiness.googleapis.com/v4/${id}`, {token});
  await ingest(env, review, location);
  await audit(env, 'review notification', id);
  return new Response(null, {status: 204});
}

export default {
  async fetch(request, env) {
    try {
      config(env);
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_BASE_URL) return json({error: 'Invalid host.'}, 403);
      if (url.pathname === '/webhooks/pubsub') return request.method === 'POST' ? await push(request, env) : json({error: 'Not found.'}, 404);
      if (request.method === 'POST' && !sameOrigin(request, env)) return json({error: 'Invalid origin.'}, 403);
      if (url.pathname === '/login' && request.method === 'POST' && env.SITES_PRIVATE_AUTH !== '1') return login(request, env);
      const sid = await auth(request, env);
      if (!sid) return env.SITES_PRIVATE_AUTH !== '1' && url.pathname === '/' && request.method === 'GET' ? page(loginPage) : json({error: 'Sign in required.'}, 401);
      if (url.pathname === '/logout' && request.method === 'POST') {
        if (env.SITES_PRIVATE_AUTH === '1') return json({error: 'Use the Sites sign-out link.'}, 400);
        await run(env, 'DELETE FROM sessions WHERE id=?', sid);
        return json({ok: true}, 200, {'Set-Cookie': cookie('', 0)});
      }
      if (url.pathname === '/' && request.method === 'GET') return page(env.SITES_PRIVATE_AUTH === '1' ? html.replace('<button data-action="logout">Sign out</button>', '<a class="signout" href="/signout-with-chatgpt?return_to=%2F">Sign out</a>') : html);
      if (url.pathname === '/api/state' && request.method === 'GET') return json(await state(env));
      if (url.pathname === '/api/oauth/start' && request.method === 'GET') return json({url: await oauthStart(env, sid)});
      if (url.pathname === '/oauth/callback' && request.method === 'GET') {
        await oauthFinish(env, sid, url);
        return new Response(null, {status: 303, headers: {...headers, Location: '/?connected=1'}});
      }
      if (url.pathname.startsWith('/api/') && request.method === 'POST') return json(await act(env, url.pathname.slice(5), await input(request)));
      return json({error: 'Not found.'}, 404);
    } catch (error) {
      return json({error: String(error.message || 'Request failed.').slice(0, 300)}, error instanceof SyntaxError ? 400 : error.status >= 500 ? 503 : 400);
    }
  },
  async scheduled(_event, env) {
    config(env);
    await purge(env);
    try {
      if (await one(env, "SELECT 1 FROM secrets WHERE name='google_refresh'") && await one(env, 'SELECT 1 FROM locations WHERE enabled=1')) await sync(env);
      await autoTick(env);
    } catch (e) {await audit(env, 'scheduled check failed', '', e.message); throw e;}
  }
};
