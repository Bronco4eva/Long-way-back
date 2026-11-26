// Reminder sender for The Long Way Back.
// Stores, per phone: the push address the phone gave us, its time zone, the hours to nudge in, and a
// "walked recently" time. Never a location, a name or game progress.

const GAME_ORIGIN = 'https://bronco4eva.github.io';
const CONTACT = 'https://bronco4eva.github.io/Long-way-back/';
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_PHONES = 200;

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
    const status = await sendPush(env, rec.sub, nudge());
    if (status === 404 || status === 410) await env.SUBS.delete(name); else sent++;
  }
  return sent;
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
    if (request.method === 'GET' && url.pathname === '/') return reply({ok:true, what:'The Long Way Back reminders'}, 200, origin);
    if (request.method === 'GET' && url.pathname === '/key') return reply({key:(await vapid(env)).pub}, 200, origin);
    if (request.method !== 'POST') return reply({error:'not found'}, 404, origin);
    if (origin !== GAME_ORIGIN) return reply({error:'only the game may call this'}, 403, origin);
    let j; try { j = await request.json(); } catch { return reply({error:'bad request'}, 400, origin); }

    if (url.pathname === '/subscribe'){
      if (!validSub(j.sub) || !hourOk(j.from) || !hourOk(j.to) || j.from >= j.to || localHour(String(j.tz)) < 0) return reply({error:'bad request'}, 400, origin);
      const name = await keyFor(j.sub.endpoint);
      if (!(await env.SUBS.get(name)) && (await listPhones(env)).length >= MAX_PHONES) return reply({error:'full'}, 429, origin);
      await env.SUBS.put(name, JSON.stringify({sub:{endpoint:j.sub.endpoint, keys:{p256dh:j.sub.keys.p256dh, auth:j.sub.keys.auth}}, tz:String(j.tz), from:j.from, to:j.to, quietUntil:0}));
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
