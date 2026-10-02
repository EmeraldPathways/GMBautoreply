import {DEFAULT, REVIEW_NAME, analytics} from './core.js';
const DAY = 86400000;
export const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
export async function loadSettings(env) {
  await run(env, 'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)', JSON.stringify(DEFAULT));
  return {...DEFAULT, ...JSON.parse((await one(env, 'SELECT data FROM settings WHERE id=1')).data)};
}
export const putSettings = (env, s) => run(env, 'UPDATE settings SET data=? WHERE id=1', JSON.stringify(s));
export async function audit(env, action, review = '', detail = '') {
  let digest = '';
  if (review) digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(review)))].slice(0, 6).map(x => x.toString(16).padStart(2, '0')).join('');
  await run(env, 'INSERT INTO audit(ts,action,review,detail) VALUES(?,?,?,?)', Date.now(), action, digest, String(detail).slice(0, 300));
}
export async function purge(env, now = Date.now()) {
  const cutoff = now - 30 * DAY;
  await run(env, 'DELETE FROM reviews WHERE demo=0 AND (first_seen<? OR created<?)', cutoff, new Date(cutoff).toISOString());
  await run(env, 'DELETE FROM locations WHERE seen<?', cutoff);
  await run(env, 'DELETE FROM audit WHERE ts<?', cutoff);
  await run(env, 'DELETE FROM oauth_states WHERE expires<?', now);
  await run(env, 'DELETE FROM sessions WHERE expires<?', now);
  await run(env, 'DELETE FROM login_attempts WHERE expires<?', now);
  await run(env, 'DELETE FROM daily_budget WHERE day<?', new Date(cutoff).toISOString().slice(0, 10));
}
export async function ingest(env, r, parent, now = Date.now()) {
  const id = r.name || `${parent}/reviews/${r.reviewId}`;
  if (!REVIEW_NAME.test(id) || !id.startsWith(`${parent}/reviews/`)) throw Error('Invalid review name from Google.');
  const created = r.createTime || '';
  if (!Number.isFinite(Date.parse(created)) || Date.parse(created) < now - 30 * DAY) return false;
  const rating = {ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5}[r.starRating] || 0;
  const name = r.reviewer?.displayName || 'Customer', body = r.comment || '', updated = r.updateTime || '';
  const reply = r.reviewReply?.comment || '', published = r.reviewReply?.updateTime || '';
  const old = await one(env, 'SELECT * FROM reviews WHERE id=?', id);
  if (!old) {
    await run(env, 'INSERT OR IGNORE INTO reviews(id,name,rating,text,draft,status,demo,updated,location,created,first_seen,published_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, name, rating, body, reply, reply ? 'published' : 'new', 0, updated, parent, created, now, published, 'Google');
    return true;
  }
  const changed = old.updated !== updated || old.text !== body || old.rating !== rating;
  let status = old.status, draft = old.draft, flag = old.flag;
  if (reply) {status = 'published'; draft = reply; flag = '';}
  else if (old.status === 'published') {status = 'draft'; flag = 'Google reply was removed; check before replying again';}
  else if (changed) {status = old.draft ? 'draft' : 'new'; flag = 'Review changed; recheck the reply';}
  await run(env, 'UPDATE reviews SET name=?,rating=?,text=?,draft=?,status=?,updated=?,location=?,created=?,published_at=?,flag=? WHERE id=?', name, rating, body, draft, status, updated, parent, created, published, flag, id);
  return true;
}
export async function getReview(env, id) {
  const r = typeof id === 'string' ? await one(env, 'SELECT * FROM reviews WHERE id=?', id) : null;
  if (!r) throw Error('Review not found.');
  return r;
}
export async function saveDraft(env, id, text, mode = 'save', flag = '') {
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw Error('Reply must contain 1–4096 characters.');
  const r = await getReview(env, id);
  if (['published', 'sample-replied', 'publishing', 'processing'].includes(r.status)) throw Error('This reply is being processed or is read-only. Reload and try again.');
  const status = mode === 'approve' ? 'approved' : 'draft';
  const result = await run(env, "UPDATE reviews SET draft=?,status=?,flag=?,theme='' WHERE id=? AND status NOT IN ('published','sample-replied','publishing','processing')", text.trim(), status, mode === 'approve' ? '' : (flag || r.flag), id);
  if (!result.meta.changes) throw Error('Review status changed; reload and try again.');
  await audit(env, mode, id);
  return getReview(env, id);
}
export async function learn(env, id) {
  const r = await getReview(env, id);
  if (r.demo || !r.draft) return;
  const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)))].map(x => x.toString(16).padStart(2, '0')).join('');
  await run(env, "INSERT INTO examples(review_id,original,reply,created) VALUES(?,'',?,?) ON CONFLICT(review_id) DO UPDATE SET reply=excluded.reply,created=excluded.created", key, r.draft, Date.now());
}
export async function state(env) {
  await purge(env);
  const [reviews, locations, examples, history, s, token] = await Promise.all([
    all(env, 'SELECT * FROM reviews ORDER BY demo ASC, created DESC, first_seen DESC'),
    all(env, 'SELECT * FROM locations ORDER BY title'),
    all(env, 'SELECT * FROM examples ORDER BY created DESC LIMIT 100'),
    all(env, 'SELECT * FROM audit ORDER BY ts DESC LIMIT 60'),
    loadSettings(env), one(env, "SELECT 1 FROM secrets WHERE name='google_refresh'")
  ]);
  return {reviews, locations, examples, audit: history.map(x => ({...x, ts: x.ts / 1000})), settings: {...s, synced_at: s.synced_at / 1000}, analytics: analytics(reviews, s),
    ai: !!env.OPENAI_API_KEY, google: !!token, oauth_ready: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), notifications_ready: !!(env.PUBSUB_TOPIC && env.PUSH_SERVICE_ACCOUNT && env.PUSH_AUDIENCE)};
}
