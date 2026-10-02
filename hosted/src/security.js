const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)), x => x.charCodeAt(0));
async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
export async function createSession(env, now = Date.now()) {
  const payload = b64(enc.encode(JSON.stringify({sid: crypto.randomUUID(), exp: now + 12 * 3600000})));
  const sig = b64(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload)));
  return `${payload}.${sig}`;
}
export async function readSession(cookie, env, now = Date.now()) {
  try {
    if (!cookie || cookie.length > 1024) return null;
    const [payload, signature, extra] = cookie.split('.');
    if (!payload || !signature || extra) return null;
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64(signature), enc.encode(payload))) return null;
    const data = JSON.parse(dec.decode(fromB64(payload)));
    return typeof data.sid === 'string' && Number.isFinite(data.exp) && data.exp > now ? data.sid : null;
  } catch { return null; }
}
export async function checkPassword(candidate, secret) {
  if (typeof candidate !== 'string' || candidate.length > 1024) return false;
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(candidate)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function aesKey(env) {
  const bytes = fromB64(env.TOKEN_KEY);
  if (bytes.length !== 32) throw Error('TOKEN_KEY must be 32 random bytes encoded as base64.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealToken(token, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(env), enc.encode(token));
  return `${b64(iv)}.${b64(ciphertext)}`;
}
export async function unsealToken(value, env) {
  const [iv, data] = value.split('.');
  if (!iv || !data) throw Error('Invalid stored token.');
  return dec.decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromB64(iv)}, await aesKey(env), fromB64(data)));
}
export async function verifyPushJWT(token, env, fetchKeys = fetch) {
  if (!env.PUSH_AUDIENCE || !env.PUSH_SERVICE_ACCOUNT) throw Error('Push authentication is not configured.');
  if (typeof token !== 'string' || token.length > 8192) throw Error('Invalid push token.');
  const pieces = token.split('.');
  if (pieces.length !== 3) throw Error('Invalid push token.');
  const [h, p, sig] = pieces;
  const header = JSON.parse(dec.decode(fromB64(h))), claims = JSON.parse(dec.decode(fromB64(p)));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw Error('Unexpected JWT algorithm.');
  const response = await fetchKeys('https://www.googleapis.com/oauth2/v3/certs');
  if (!response.ok) throw Error('Google signing keys unavailable.');
  const jwks = await response.json(), jwk = jwks.keys?.find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw Error('Unknown Google signing key.');
  const key = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64(sig), enc.encode(`${h}.${p}`))) throw Error('Invalid Google signature.');
  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== env.PUSH_AUDIENCE || claims.email !== env.PUSH_SERVICE_ACCOUNT || ![true, 'true'].includes(claims.email_verified) || !Number.isFinite(claims.iat) || claims.iat > now + 60 || !Number.isFinite(claims.exp) || claims.exp <= now) throw Error('Invalid push identity.');
  return claims;
}
