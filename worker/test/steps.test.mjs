// Checks the step intake without Cloudflare: fake storage and a fake push service.
import assert from 'node:assert/strict';
import worker, { runNudges, parseHours, takeSteps } from '../src/index.js';

const kv = new Map(); let writes = 0;
const env = {SUBS:{
  get: async (k, t) => kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null,
  put: async (k, v) => { writes++; kv.set(k, v); }, delete: async k => { kv.delete(k); },
  list: async ({prefix}) => ({keys:[...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({name})), list_complete:true})
}};
const sent = []; globalThis.fetch = async (url, init) => { sent.push(url); return new Response('', {status:201}); };
const GAME = 'https://bronco4eva.github.io';
const call = (path, body, origin = GAME) => worker.fetch(new Request('https://w.example' + path, {method:'POST', headers:{...(origin ? {Origin:origin} : {}), 'content-type':'application/json'}, body:JSON.stringify(body)}), env);
const phoneGet = path => worker.fetch(new Request('https://w.example' + path), env);   // the shortcut: a plain GET with no page behind it

assert.deepEqual(parseHours('9-320_10-45_14-1,200'), {9:320, 10:45, 14:1200});
assert.deepEqual(parseHours('9-320.5_10-45 steps_25-9_x'), {9:320, 10:45}, 'decimals, trailing words and bad hours');
assert.deepEqual(parseHours(''), {}); assert.deepEqual(parseHours(null), {});

const code = 'Abcdefghij0123456789xyz';
assert.equal((await phoneGet('/steps/' + code + '?hours=9-300')).status, 404, 'a code the game never made is refused');
assert.equal(kv.size, 0, 'and nothing is stored for it');
assert.equal((await phoneGet('/steps/short?hours=9-300')).status, 400);
assert.equal((await call('/steps-on', {code}, 'https://evil.example')).status, 403, 'only the game can make a code');
assert.equal((await call('/steps-on', {code:'nope'})).status, 400);
assert.equal((await call('/steps-read', {code})).status, 404);
assert.equal((await call('/steps-on', {code})).status, 200);

let r = await phoneGet('/steps/' + code + '?hours=9-300_10-1,250'); assert.deepEqual(await r.json(), {ok:true, steps:1550});
r = await call('/steps-read', {code}); let j = await r.json();
assert.deepEqual(j.hours, {9:300, 10:1250}); assert.ok(Date.now() - j.at < 5000);
assert.equal(r.headers.get('access-control-allow-origin'), GAME);

writes = 0; await phoneGet('/steps/' + code + '?hours=9-300_10-1,250'); assert.equal(writes, 0, 'nothing new, nothing written');
await phoneGet('/steps/' + code + '?hours=9-300_10-1,400'); assert.equal(writes, 1);
await phoneGet('/steps/' + code + '?hours='); assert.deepEqual((await (await call('/steps-read', {code})).json()).hours, {}, 'a new day starts empty');

// Tobiah does not call in an hour the phone says was walked
const sub = {endpoint:'https://web.push.apple.com/abc123', keys:{p256dh:Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth:Buffer.alloc(16, 2).toString('base64url')}};
assert.equal((await call('/subscribe', {sub, tz:'UTC', from:0, to:24})).status, 200);
assert.equal((await call('/steps-on', {code, endpoint:sub.endpoint})).status, 200);
const now = new Date('2026-11-27T15:50:00Z'), t = now.getTime();
const pushed = async () => { sent.length = 0; try { await runNudges(env, now); } catch {} return sent.length; };   // the pretend phone key cannot be encrypted to; reaching the push step is what counts
const nudged = async () => { let tried = false; const real = crypto.subtle.generateKey.bind(crypto.subtle); crypto.subtle.generateKey = async (...a) => { tried = true; return real(...a); }; await pushed(); crypto.subtle.generateKey = real; return tried; };
await takeSteps(env, code, '15-400', t - 5 * 60000); assert.equal(await nudged(), false, 'walked this hour: no call');
await takeSteps(env, code, '15-100', t - 5 * 60000); assert.equal(await nudged(), true, 'too few steps: call');
await takeSteps(env, code, '14-900', t - 5 * 60000); assert.equal(await nudged(), true, 'last hour does not count');
await takeSteps(env, code, '15-401', t - 3 * 3600000); assert.equal(await nudged(), true, 'old news does not count');
assert.equal((await call('/subscribe', {sub, tz:'UTC', from:0, to:24})).status, 200);
await takeSteps(env, code, '15-400', t - 5 * 60000); assert.equal(await nudged(), false, 'changing the hours keeps the tie');

assert.equal((await call('/steps-off', {code, endpoint:sub.endpoint})).status, 200);
assert.equal((await call('/steps-read', {code})).status, 404);
assert.equal(await nudged(), true, 'disconnected: Tobiah calls as before');
console.log('steps: all checks passed');
