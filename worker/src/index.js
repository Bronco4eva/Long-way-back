// Reminder sender for The Long Way Back.
// Stores, per phone: the push address the phone gave us, its time zone, the hours to nudge in, and a
// "walked recently" time. Never a location, a name or game progress.

const GAME_ORIGIN = 'https://bronco4eva.github.io';
const CONTACT = 'https://bronco4eva.github.io/Long-way-back/';
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_PHONES = 200;

// Steps from a phone's Health app. An iPhone shortcut calls /steps/<code> with today's count for each hour; the game,
// which made the code, reads it back. We keep the hourly counts for the day and when they came. Nothing else from Health.
const STEPS = {round:250, fresh:70 * 60000, keep:30 * 86400, sameFor:6 * 3600000};
const codeOk = c => typeof c === 'string' && /^[A-Za-z0-9]{20,40}$/.test(c);
const stepsKey = async code => 'steps:' + hex(await crypto.subtle.digest('SHA-256', enc.encode('steps|' + code))).slice(0, 32);
// "9-320_10-45_14-1,200" -> {9:320, 10:45, 14:1200}. Hours the phone left out had no steps.
export function parseHours(text){
  const out = {};
  String(text || '').split('_').slice(0, 48).forEach(part => {
    const m = /^\s*(\d{1,2})\s*-\s*([\d.,\s]+)/.exec(part); if (!m) return;
    const h = +m[1], n = +m[2].trim().replace(/[.,]\d{1,2}$/, '').replace(/\D/g, '');
    if (h > 23 || !(n >= 0) || n > 60000) return;
    out[h] = Math.min(60000, (out[h] || 0) + n);
  });
  return out;
}
export async function takeSteps(env, code, text, now = Date.now()){
  if (!codeOk(code)) return [{error:'bad code'}, 400];
  const name = await stepsKey(code), rec = await env.SUBS.get(name, 'json');
  if (!rec) return [{error:'This code is not known. Open the game and connect your steps again.'}, 404];   // only the game can make a code
  const hours = parseHours(text), total = Object.values(hours).reduce((a, b) => a + b, 0);
  // Storage writes are counted on the free plan, so an hour with nothing new is not written again.
  if (JSON.stringify(hours) !== JSON.stringify(rec.hours) || now - rec.at > STEPS.sameFor) await env.SUBS.put(name, JSON.stringify({hours, at:now}), {expirationTtl:STEPS.keep});
  return [{ok:true, steps:total}, 200];
}

// Villager voices for players who have no key of their own. The key is a secret on this server (ANTHROPIC_API_KEY)
// and never reaches a phone. Caps are counted per day against a scrambled internet address; no words are stored.
const TALK = {perPlayer:40, everyone:400, maxSystem:16000, maxTurns:30, maxTurnChars:2000, maxTokens:2000, model:'claude-opus-5-5'};

const LINES = [
  'You have been down a whole hour. Up. Once round the camp.',
  'My knee set like this because I sat a winter out. Get up and walk the fence.',
  'The fire does not need watching that closely. On your feet, Stranger.',
  'Pip says you have not moved since the last tally. Prove the child wrong.',
  'Three minutes on your feet. The longhouse will still be here.',
  'Up. A round of the camp, then sit again if you must.'
];

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts){ out.set(p, i); i += p.length; } return out; };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, key, len * 8));
}

// Message encryption for Web Push (RFC 8291, aes128gcm).
export async function encryptPayload(sub, text){
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, {name:'ECDH', namedCurve:'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH', public:uaKey}, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce}, key, cat(enc.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, body);
}

// The server's own signing key pair, made on first use and kept in storage. Nobody has to paste a key anywhere.
async function vapid(env){
  let v = await env.SUBS.get('vapid', 'json');
  if (!v){
    const pair = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign', 'verify']);
    v = {jwk: await crypto.subtle.exportKey('jwk', pair.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey))};
    await env.SUBS.put('vapid', JSON.stringify(v));
  }
  return v;
}
async function vapidHeader(env, endpoint){
  const v = await vapid(env);
  const head = b64u(enc.encode(JSON.stringify({typ:'JWT', alg:'ES256'})));
  const claims = b64u(enc.encode(JSON.stringify({aud:new URL(endpoint).origin, exp:Math.floor(Date.now() / 1000) + 12 * 3600, sub:CONTACT})));
  const key = await crypto.subtle.importKey('jwk', v.jwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, enc.encode(head + '.' + claims));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.pub}`;
}

// Returns the push service's status code. 404 or 410 means the phone no longer wants these.
export async function sendPush(env, sub, message){
  const r = await fetch(sub.endpoint, {method:'POST', body:await encryptPayload(sub, JSON.stringify(message)),
    headers:{'Authorization':await vapidHeader(env, sub.endpoint), 'Content-Encoding':'aes128gcm', 'Content-Type':'application/octet-stream', 'TTL':'1800', 'Urgency':'normal'}});
  return r.status;
}

const nudge = () => ({title:'Tobiah', body:LINES[Math.floor(Math.random() * LINES.length)], tag:'round'});
const keyFor = async endpoint => 'sub:' + hex(await crypto.subtle.digest('SHA-256', enc.encode(endpoint))).slice(0, 32);
export function localHour(tz, now = new Date()){
  try { return +new Intl.DateTimeFormat('en-US', {timeZone:tz, hour:'numeric', hourCycle:'h23'}).format(now) % 24; } catch { return -1; }
}
function validSub(s){
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some(re => re.test(u.hostname)) && s.endpoint.length < 1000
      && unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length === 16;
  } catch { return false; }
}
const hourOk = h => Number.isInteger(h) && h >= 0 && h <= 24;

async function listPhones(env){
  const out = []; let cursor;
  do { const page = await env.SUBS.list({prefix:'sub:', cursor}); out.push(...page.keys.map(k => k.name)); cursor = page.list_complete ? null : page.cursor; } while (cursor);
  return out;
}

export async function runNudges(env, now = new Date()){
  let sent = 0;
  for (const name of await listPhones(env)){
    const rec = await env.SUBS.get(name, 'json'); if (!rec) continue;
    const h = localHour(rec.tz, now);
    if (h < rec.from || h >= rec.to) continue;                 // outside the hours they asked for
    if (rec.quietUntil && rec.quietUntil > now.getTime()) continue;   // they walked a moment ago
    if (rec.steps){                                            // their phone says they have already walked this hour
      const st = await env.SUBS.get(rec.steps, 'json');
      if (st && now.getTime() - st.at < STEPS.fresh && localHour(rec.tz, new Date(st.at)) === h && (st.hours[h] || 0) >= STEPS.round) continue;
    }
    const status = await sendPush(env, rec.sub, nudge());
    if (status === 404 || status === 410) await env.SUBS.delete(name); else sent++;
  }
  return sent;
}

const day = () => new Date().toISOString().slice(0, 10);
function validTalk(j){
  return j && typeof j.system === 'string' && j.system.length > 0 && j.system.length <= TALK.maxSystem
    && Array.isArray(j.messages) && j.messages.length > 0 && j.messages.length <= TALK.maxTurns
    && j.messages.every(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0 && m.content.length <= TALK.maxTurnChars);
}
async function callClaude(env, j, withFallback){
  const headers = {'content-type':'application/json', 'x-api-key':env.ANTHROPIC_API_KEY, 'anthropic-version':'2026-10-21'};
  const body = {model:env.TALK_MODEL || TALK.model, max_tokens:TALK.maxTokens, system:j.system, messages:j.messages.map(m => ({role:m.role, content:m.content})), output_config:{effort:'low'}};
  // If a safety check declines a request, let Anthropic hand it to another model instead of failing.
  if (withFallback){ headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
  return fetch('https://api.anthropic.com/v1/messages', {method:'POST', headers, body:JSON.stringify(body)});
}
export async function talk(request, env, j){
  if (!env.ANTHROPIC_API_KEY) return [{error:'no_key'}, 503];
  if (!validTalk(j)) return [{error:'bad request'}, 400];
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown', d = day();
  const mine = 'talk:' + d + ':' + hex(await crypto.subtle.digest('SHA-256', enc.encode(d + '|' + ip))).slice(0, 24), all = 'talk:' + d + ':all';
  const [nMine, nAll] = (await Promise.all([env.SUBS.get(mine), env.SUBS.get(all)])).map(v => +v || 0);
  if (nMine >= (+env.TALK_PER_PLAYER || TALK.perPlayer) || nAll >= (+env.TALK_EVERYONE || TALK.everyone)) return [{error:'daily_cap'}, 429];
  await Promise.all([env.SUBS.put(mine, String(nMine + 1), {expirationTtl:2 * 86400}), env.SUBS.put(all, String(nAll + 1), {expirationTtl:2 * 86400})]);
  let r = await callClaude(env, j, true);
  if (r.status === 400) r = await callClaude(env, j, false);   // in case the fallback option is not accepted
  if (r.status === 401 || r.status === 403) return [{error:'server_key_rejected'}, 502];
  if (r.status === 429 || r.status === 529) return [{error:'busy'}, 503];
  if (!r.ok) return [{error:'upstream_error'}, 502];
  const out = await r.json();
  return [{stop_reason:out.stop_reason, content:(out.content || []).filter(b => b.type === 'text').map(b => ({type:'text', text:b.text}))}, 200];
}

function reply(body, status, origin){
  const h = {'content-type':'application/json', 'vary':'Origin'};
  if (origin === GAME_ORIGIN){ h['access-control-allow-origin'] = origin; h['access-control-allow-methods'] = 'GET, POST, OPTIONS'; h['access-control-allow-headers'] = 'content-type'; h['access-control-max-age'] = '86400'; }
  return new Response(JSON.stringify(body), {status, headers:h});
}

export default {
  async fetch(request, env){
    const url = new URL(request.url), origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return reply({}, 200, origin);
    if (request.method === 'GET' && url.pathname === '/') return reply({ok:true, what:'The Long Way Back reminders', talk:!!env.ANTHROPIC_API_KEY,
      // Names only, never values: shows whether the key secret reached this server and under what exact name.
      seen:Object.keys(env).filter(k => /anthropic|api|key/i.test(k)).map(k => ({name:JSON.stringify(k), type:typeof env[k], empty:typeof env[k] !== 'string' || env[k].trim().length === 0})),
      at:new Date().toISOString()}, 200, origin);
    if (request.method === 'GET' && url.pathname === '/key') return reply({key:(await vapid(env)).pub}, 200, origin);
    // The one call that does not come from the game: the phone's shortcut, which has no page behind it.
    if (url.pathname.startsWith('/steps/')){
      const [body, status] = await takeSteps(env, url.pathname.slice(7), url.searchParams.get('hours'));
      return reply(body, status, origin);
    }
    if (request.method !== 'POST') return reply({error:'not found'}, 404, origin);
    if (origin !== GAME_ORIGIN) return reply({error:'only the game may call this'}, 403, origin);
    let j; try { j = await request.json(); } catch { return reply({error:'bad request'}, 400, origin); }

    if (url.pathname === '/talk'){ const [body, status] = await talk(request, env, j); return reply(body, status, origin); }

    if (url.pathname === '/subscribe'){
      if (!validSub(j.sub) || !hourOk(j.from) || !hourOk(j.to) || j.from >= j.to || localHour(String(j.tz)) < 0) return reply({error:'bad request'}, 400, origin);
      const name = await keyFor(j.sub.endpoint);
      const was = await env.SUBS.get(name, 'json');
      if (!was && (await listPhones(env)).length >= MAX_PHONES) return reply({error:'full'}, 429, origin);
      await env.SUBS.put(name, JSON.stringify({sub:{endpoint:j.sub.endpoint, keys:{p256dh:j.sub.keys.p256dh, auth:j.sub.keys.auth}}, tz:String(j.tz), from:j.from, to:j.to, quietUntil:0, ...(was && was.steps ? {steps:was.steps} : {})}));
      return reply({ok:true}, 200, origin);
    }
    if (url.pathname === '/steps-on' || url.pathname === '/steps-read' || url.pathname === '/steps-off'){
      if (!codeOk(j.code)) return reply({error:'bad request'}, 400, origin);
      const sName = await stepsKey(j.code), st = await env.SUBS.get(sName, 'json');
      // If this phone also takes Tobiah's calls, tie the two together so he does not call in an hour already walked.
      const pName = typeof j.endpoint === 'string' ? await keyFor(j.endpoint) : null, phone = pName ? await env.SUBS.get(pName, 'json') : null;
      if (url.pathname === '/steps-read'){
        if (st && phone && phone.steps !== sName){ phone.steps = sName; await env.SUBS.put(pName, JSON.stringify(phone)); }
        return st ? reply({ok:true, hours:st.hours, at:st.at}, 200, origin) : reply({error:'not connected'}, 404, origin);
      }
      if (url.pathname === '/steps-off'){
        await env.SUBS.delete(sName);
        if (phone && phone.steps){ delete phone.steps; await env.SUBS.put(pName, JSON.stringify(phone)); }
        return reply({ok:true}, 200, origin);
      }
      if (!st){
        if ((await env.SUBS.list({prefix:'steps:', limit:MAX_PHONES})).keys.length >= MAX_PHONES) return reply({error:'full'}, 429, origin);
        await env.SUBS.put(sName, JSON.stringify({hours:{}, at:0}), {expirationTtl:STEPS.keep});
      }
      if (phone && phone.steps !== sName){ phone.steps = sName; await env.SUBS.put(pName, JSON.stringify(phone)); }
      return reply({ok:true}, 200, origin);
    }
    const name = typeof j.endpoint === 'string' ? await keyFor(j.endpoint) : null;
    const rec = name ? await env.SUBS.get(name, 'json') : null;
    if (!rec) return reply({error:'not signed up'}, 404, origin);
    if (url.pathname === '/unsubscribe'){ await env.SUBS.delete(name); return reply({ok:true}, 200, origin); }
    if (url.pathname === '/moved'){ rec.quietUntil = Date.now() + 55 * 60000; await env.SUBS.put(name, JSON.stringify(rec)); return reply({ok:true}, 200, origin); }
    if (url.pathname === '/test'){
      const status = await sendPush(env, rec.sub, {title:'Tobiah', body:'This is how I will call you when you have sat too long.', tag:'round'});
      return reply({ok:status >= 200 && status < 300, status}, 200, origin);
    }
    return reply({error:'not found'}, 404, origin);
  },
  async scheduled(event, env, ctx){ ctx.waitUntil(runNudges(env)); }
};
