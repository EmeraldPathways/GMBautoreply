import test from 'node:test';
import assert from 'node:assert/strict';
import {environment} from './d1.mjs';
import {one, run, ingest, loadSettings} from '../src/data.js';
import {sealToken} from '../src/security.js';
import {sync, generate, publish, configureNotifications} from '../src/providers.js';

const location = 'accounts/1/locations/2', id = `${location}/reviews/3`, now = new Date().toISOString();
const googleReview = {name: id, reviewer: {displayName: 'Sarah'}, comment: 'Lovely clean', starRating: 'FIVE', createTime: now, updateTime: now};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
async function setup(fetcher) {
  const env = environment({GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPENAI_API_KEY: 'openai', __fetch: fetcher});
  await run(env, 'INSERT INTO secrets(name,value) VALUES(?,?)', 'google_refresh', await sealToken('refresh', env));
  await run(env, 'INSERT INTO locations(name,title,account,enabled,seen) VALUES(?,?,?,?,?)', location, 'Shop', 'accounts/1', 1, Date.now());
  return env;
}
test('sync ingests recent Google reviews and leaves old reviews out', async () => {
  const env = await setup(async url => String(url).includes('oauth2') ? json({access_token: 'access'}) : json({reviews: [googleReview, {...googleReview, name: `${location}/reviews/old`, createTime: '2020-01-01T00:00:00Z'}]}));
  assert.equal(await sync(env), 1);
  assert.ok(await one(env, 'SELECT id FROM reviews WHERE id=?', id));
  assert.equal(await one(env, 'SELECT id FROM reviews WHERE id LIKE ?', '%/old'), null);
});
test('structured AI output is guarded and is not stored by OpenAI', async () => {
  const calls = [];
  const env = await setup(async (url, options) => {calls.push([String(url), options]); return json({status: 'completed', output: [{content: [{type: 'output_text', text: JSON.stringify({reply: 'Thanks for your feedback.', needs_review: false, reason: '', theme: 'service'})}]}]});});
  await ingest(env, {...googleReview, comment: 'Lovely clean but the door was damaged'}, location);
  const answer = await generate(env, await one(env, 'SELECT * FROM reviews WHERE id=?', id));
  assert.match(answer.flag, /complaint/i);
  assert.equal(JSON.parse(calls[0][1].body).store, false);
  assert.equal(JSON.parse(calls[0][1].body).text.format.type, 'json_schema');
});
test('publish reads Google again and will not overwrite an outside reply', async () => {
  const env = await setup(async url => String(url).includes('oauth2') ? json({access_token: 'access'}) : json({...googleReview, reviewReply: {comment: 'Already answered'}}));
  await ingest(env, googleReview, location);
  await run(env, "UPDATE reviews SET draft='Thank you',status='approved' WHERE id=?", id);
  await assert.rejects(publish(env, await one(env, 'SELECT * FROM reviews WHERE id=?', id)), /already has a reply/i);
  assert.equal((await one(env, 'SELECT status FROM reviews WHERE id=?', id)).status, 'draft');
});
test('a disabled location cannot publish even an approved draft', async () => {
  const env = await setup(async () => {throw Error('Google must not be called');});
  await ingest(env, googleReview, location);
  await run(env, "UPDATE reviews SET draft='Thank you',status='approved' WHERE id=?", id);
  await run(env, 'UPDATE locations SET enabled=0 WHERE name=?', location);
  await assert.rejects(publish(env, await one(env, 'SELECT * FROM reviews WHERE id=?', id)), /selected location/i);
});
test('notification setup refuses to replace a different account topic', async () => {
  const env = await setup(async url => String(url).includes('oauth2') ? json({access_token: 'access'}) : json({pubsubTopic: 'projects/another/topics/existing', notificationTypes: ['NEW_REVIEW']}));
  env.PUBSUB_TOPIC = 'projects/mine/topics/reviews';
  env.PUSH_AUDIENCE = 'https://desk.example/webhooks/pubsub';
  env.PUSH_SERVICE_ACCOUNT = 'review-push@example.iam.gserviceaccount.com';
  await assert.rejects(configureNotifications(env), /already uses another topic/i);
});
