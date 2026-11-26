// Checks the Worker without Cloudflare: fake storage, fake push service, and an independent decrypt of what it sends.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import worker, { runNudges, localHour } from '../src/index.js';
const ece = createRequire(import.meta.url)('http_ece');

const kv = new Map();
const env = {SUBS:{
  get: async (k, t) => kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null,
  put: async (k, v) => { kv.set(k, v); }, delete: async k => { kv.delete(k); },
  list: async ({prefix}) => ({keys:[...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({name})), list_complete:true})
}};
const b64u = b => Buffer.from(b).toString('base64url');
// A pretend phone
const phone = crypto.createECDH('prime256v1'); phone.generateKeys();
const auth = crypto.randomBytes(16);
const sub = {endpoint:'https://web.push.apple.com/abc123', keys:{p256dh:b64u(phone.getPublicKey()), auth:b64u(auth)}};
const sent = []; let pushStatus = 201;
globalThis.fetch = async (url, init) => { sent.push({url, init}); return new Response('', {status:pushStatus}); };
const call = (path, body, origin = 'https://bronco4eva.github.io', method = 'POST') =>
  worker.fetch(new Request('https://w.example' + path, {method, headers:{Origin:origin, 'content-type':'application/json'}, body:body ? JSON.stringify(body) : undefined}), env);

let r = await call('/key', null, undefined, 'GET'); const {key} = await r.json();
assert.equal(Buffer.from(key, 'base64url').length, 65, 'public key is an uncompressed P-256 point');
assert.equal((await (await call('/key', null, undefined, 'GET')).json()).key, key, 'key is stable');

assert.equal((await call('/subscribe', {sub, tz:'America/Denver', from:9, to:20}, 'https://evil.example')).status, 403);
assert.equal((await call('/subscribe', {sub:{...sub, endpoint:'https://evil.example/x'}, tz:'America/Denver', from:9, to:20})).status, 400);
assert.equal((await call('/subscribe', {sub, tz:'Nowhere/Land', from:9, to:20})).status, 400);
assert.equal((await call('/subscribe', {sub, tz:'America/Denver', from:20, to:9})).status, 400);
r = await call('/subscribe', {sub, tz:'America/Denver', from:9, to:20}); assert.equal(r.status, 200);
assert.equal(r.headers.get('access-control-allow-origin'), 'https://bronco4eva.github.io');

r = await call('/test', {endpoint:sub.endpoint}); assert.deepEqual(await r.json(), {ok:true, status:201});
const p = sent.pop(); assert.equal(p.url, sub.endpoint); assert.equal(p.init.headers['Content-Encoding'], 'aes128gcm');
// independent decrypt, the way a browser would
const plain = ece.decrypt(Buffer.from(p.init.body), {version:'aes128gcm', privateKey:phone, authSecret:b64u(auth)});
const msg = JSON.parse(plain.toString()); assert.equal(msg.title, 'Tobiah'); assert.ok(msg.body.length > 10);
// the signed pass the push service checks
const m = /^vapid t=([^,]+), k=(.+)$/.exec(p.init.headers.Authorization); assert.ok(m); assert.equal(m[2], key);
const [h, c, s] = m[1].split('.'); const claims = JSON.parse(Buffer.from(c, 'base64url'));
assert.equal(claims.aud, 'https://web.push.apple.com'); assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400); assert.ok(claims.sub.startsWith('https://'));
const pubKey = crypto.createPublicKey({key:Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from(key, 'base64url')]), format:'der', type:'spki'});
assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), {key:pubKey, dsaEncoding:'ieee-p1363'}, Buffer.from(s, 'base64url')), 'signature checks out');

// hourly run: 12:50 in Denver is inside 9 to 20, 03:50 is not
assert.equal(localHour('America/Denver', new Date('2026-11-26T19:50:00Z')), 12);
assert.equal(localHour('America/Denver', new Date('2026-11-26T07:00:00Z')), 0);
assert.equal(await runNudges(env, new Date('2026-11-26T19:50:00Z')), 1); assert.equal(sent.length, 1);
assert.equal(await runNudges(env, new Date('2026-11-26T10:50:00Z')), 0); assert.equal(sent.length, 1);
assert.equal(await runNudges(env, new Date('2026-11-27T03:50:00Z')), 0, '8:50 PM is past the end hour');
// walked recently: stays quiet
await call('/moved', {endpoint:sub.endpoint}); assert.equal(await runNudges(env, new Date()), 0);
// phone says it no longer wants pushes: forgotten
const rec = JSON.parse(kv.get([...kv.keys()].find(k => k.startsWith('sub:')))); rec.quietUntil = 0; kv.set([...kv.keys()].find(k => k.startsWith('sub:')), JSON.stringify(rec));
pushStatus = 410; assert.equal(await runNudges(env, new Date('2026-11-26T19:50:00Z')), 0); assert.equal([...kv.keys()].filter(k => k.startsWith('sub:')).length, 0);
assert.equal((await call('/test', {endpoint:sub.endpoint})).status, 404);
// nothing stored but the push address, zone, hours and quiet time
assert.deepEqual(Object.keys(rec).sort(), ['from', 'quietUntil', 'sub', 'to', 'tz']);

// ---- villager voices through the server's own key ----
const good = {system:'You are Pip.', messages:[{role:'user', content:'Hello'}]};
assert.equal((await call('/talk', good)).status, 503, 'no key set: relay is off');
assert.equal((await (await call('/', null, undefined, 'GET')).json()).talk, false);
env.ANTHROPIC_API_KEY = 'sk-test'; env.TALK_PER_PLAYER = '2';
assert.equal((await (await call('/', null, undefined, 'GET')).json()).talk, true);
assert.equal((await call('/talk', good, 'https://evil.example')).status, 403);
assert.equal((await call('/talk', {system:'x', messages:[{role:'system', content:'hi'}]})).status, 400);
assert.equal((await call('/talk', {system:'x'.repeat(20000), messages:good.messages})).status, 400);
let mode = 'ok'; sent.length = 0;
globalThis.fetch = async (url, init) => { sent.push({url, init});
  if (mode === 'reject-fallback' && JSON.parse(init.body).fallbacks) return new Response('{}', {status:400});
  return new Response(JSON.stringify({stop_reason:'end_turn', content:[{type:'thinking', thinking:''}, {type:'text', text:'Forty-one steps.'}], usage:{}}), {status:200}); };
r = await call('/talk', good); assert.equal(r.status, 200);
assert.deepEqual(await r.json(), {stop_reason:'end_turn', content:[{type:'text', text:'Forty-one steps.'}]});
const q = sent[0]; assert.equal(q.url, 'https://api.anthropic.com/v1/messages'); assert.equal(q.init.headers['x-api-key'], 'sk-test');
const qb = JSON.parse(q.init.body); assert.equal(qb.model, 'claude-opus-5-5'); assert.equal(qb.fallbacks, 'default'); assert.equal(qb.max_tokens, 2000); assert.ok(!('temperature' in qb));
mode = 'reject-fallback'; sent.length = 0; r = await call('/talk', good); assert.equal(r.status, 200); assert.equal(sent.length, 2); assert.ok(!JSON.parse(sent[1].init.body).fallbacks);
r = await call('/talk', good); assert.equal(r.status, 429, 'third reply of the day for this player is refused'); assert.deepEqual(await r.json(), {error:'daily_cap'});
assert.ok(![...kv.values()].some(v => String(v).includes('Hello') || String(v).includes('sk-test')), 'no words and no key in storage');
console.log('all push checks passed');
