import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession, readSession, sealToken, unsealToken, verifyPushJWT} from '../src/security.js';

const env = {SESSION_SECRET: 'a'.repeat(48), TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), PUSH_AUDIENCE: 'https://desk.example/webhooks/pubsub', PUSH_SERVICE_ACCOUNT: 'review-push@example.iam.gserviceaccount.com'};
test('session signature and expiry are checked', async () => {
  const cookie = await createSession(env, 1000);
  const sid = await readSession(cookie, env, 1001);
  assert.ok(sid);
  assert.equal(await readSession(cookie + 'x', env, 1001), null);
  assert.equal(await readSession(cookie, env, 1000 + 13 * 3600000), null);
});
test('Google refresh token ciphertext changes with nonce and tampering fails', async () => {
  const a = await sealToken('refresh-secret', env), b = await sealToken('refresh-secret', env);
  assert.notEqual(a, b);
  assert.equal(await unsealToken(a, env), 'refresh-secret');
  await assert.rejects(unsealToken(a.slice(0, -2) + 'xx', env));
});
test('Pub/Sub JWT validates signature, audience, email, issuer and expiry', async () => {
  const {publicKey, privateKey} = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
  const jwk = {...await crypto.subtle.exportKey('jwk', publicKey), kid: 'test-key'};
  const b64 = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const head = b64({alg: 'RS256', kid: 'test-key'});
  const now = Math.floor(Date.now() / 1000);
  async function signed(claims) {
    const payload = b64({iss: 'https://accounts.google.com', aud: env.PUSH_AUDIENCE, email: env.PUSH_SERVICE_ACCOUNT, email_verified: true, iat: now, exp: now + 3600, ...claims});
    const bytes = new TextEncoder().encode(`${head}.${payload}`);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, bytes);
    return `${head}.${payload}.${Buffer.from(sig).toString('base64url')}`;
  }
  const fetchKeys = async () => new Response(JSON.stringify({keys: [jwk]}), {status: 200});
  await verifyPushJWT(await signed({}), env, fetchKeys);
  await assert.rejects(verifyPushJWT(await signed({aud: 'wrong'}), env, fetchKeys));
  await assert.rejects(verifyPushJWT(await signed({email_verified: false}), env, fetchKeys));
  await assert.rejects(verifyPushJWT(await signed({exp: now - 10}), env, fetchKeys));
  const good = await signed({});
  await assert.rejects(verifyPushJWT(good.slice(0, -3) + 'bad', env, fetchKeys));
});
