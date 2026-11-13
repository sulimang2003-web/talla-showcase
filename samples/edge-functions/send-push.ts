// Sends push notifications. Called by the orders_push_new trigger (pg_net) with x-push-secret.
// Devices: Web Push (browser / installed PWA), FCM (Android app, endpoint 'fcm:<token>'),
// APNs (iPhone app, endpoint 'apns:<token>'). The store apps live in mobile/.
// New order -> the shop owner's devices (Talla app) and every admin's devices (admin panel).
// Campaign (from dispatch_campaigns / admin_test_campaign) -> promo notification to customers.
// Deployed with verify_jwt = false; the shared secret from Vault is the auth.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import { importPKCS8, SignJWT } from 'npm:jose@5.9.6';

const APP_URL = { customer: 'https://altallcostmer.netlify.app/', admin: 'https://altalldeliveri.netlify.app/' } as const;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

let cfg: Record<string, string> | null = null;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  if (!cfg) {
    const { data, error } = await db.rpc('push_config');
    if (error || !data) return json({ error: 'no push config' }, 500);
    cfg = data as Record<string, string>;
    webpush.setVapidDetails('mailto:talla.app26@gmail.com', cfg.vapid_public, cfg.vapid_private);
  }
  if (req.headers.get('x-push-secret') !== cfg.push_secret) return json({ error: 'forbidden' }, 403);

  const body = await req.json().catch(() => ({}));
  if (body.type === 'campaign') return campaign(db, body.campaign_id);
  if (body.type === 'campaign_test') return campaignTest(db, body);
  if (!body.order_id) return json({ error: 'bad request' }, 400);
  if (body.type === 'driver_assigned') return driverAssigned(db, body.order_id);
  if (body.type === 'status') return statusChanged(db, body.order_id);
  if (body.type !== 'new_order') return json({ error: 'bad request' }, 400);

  const { data: o } = await db.from('orders')
    .select('id, order_number, total, total_syp, fulfillment, scheduled_for, restaurant_id, restaurants(name, owner_id), order_items(quantity)')
    .eq('id', body.order_id).single();
  if (!o) return json({ error: 'order not found' }, 404);

  const rest = (o as any).restaurants || {};
  const { data: admins } = await db.from('profiles').select('id').eq('role', 'admin');
  const ownerIds = rest.owner_id ? [rest.owner_id] : [];
  const adminIds = (admins || []).map((a: any) => a.id);
  const ids = [...new Set([...ownerIds, ...adminIds])];
  if (!ids.length) return json({ sent: 0 });

  const { data: subs } = await db.from('push_subscriptions').select('*').in('user_id', ids);
  const qty = ((o as any).order_items || []).reduce((n: number, i: any) => n + Number(i.quantity || 0), 0);
  const money = o.total_syp != null ? `${Number(o.total_syp).toLocaleString('ar-SY')} ل.س` : `$${o.total}`;
  const how = o.fulfillment === 'pickup' ? 'استلام من المحل' : 'توصيل';

  let sent = 0, gone = 0;
  await Promise.all((subs || []).map(async (s: any) => {
    // owners get it in the Talla app; admins get it in whichever app they subscribed from
    const isOwner = ownerIds.includes(s.user_id) && s.app === 'customer';
    const isAdmin = adminIds.includes(s.user_id);
    if (!isOwner && !isAdmin) return;
    const r = await deliver(db, s, {
      title: `${o.scheduled_for ? '⏰ طلب مسبق' : '🔔 طلب جديد'} #${o.order_number ?? ''}`,
      body: `${isOwner ? '' : `${rest.name || ''} · `}${qty} صنف · ${money} · ${how}`,
      url: APP_URL[s.app as 'customer' | 'admin'] || APP_URL.customer,
      tag: `order-${o.id}`,
    });
    if (r === 'ok') sent++; else if (r === 'gone') gone++;
  }));
  return json({ sent, gone });
});

type Sub = { id: number; endpoint: string; p256dh: string; auth: string };
type Msg = { title: string; body: string; url: string; tag: string };

// One device, whichever kind it is. A device that no longer exists is removed.
async function deliver(db: any, s: Sub, m: Msg): Promise<'ok' | 'gone' | 'err'> {
  let r: 'ok' | 'gone' | 'err';
  if (s.endpoint.startsWith('fcm:')) r = await sendFcm(s.endpoint.slice(4), m);
  else if (s.endpoint.startsWith('apns:')) r = await sendApns(s.endpoint.slice(5), m);
  else r = await sendWeb(s, m);
  if (r === 'ok') await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('id', s.id);
  if (r === 'gone') await db.from('push_subscriptions').delete().eq('id', s.id);
  return r;
}

async function sendTo(db: any, subs: Sub[], payload: string) {
  const m = JSON.parse(payload) as Msg;
  let sent = 0, gone = 0;
  await Promise.all(subs.map(async (s) => {
    const r = await deliver(db, s, m);
    if (r === 'ok') sent++; else if (r === 'gone') gone++;
  }));
  return { sent, gone };
}

async function sendWeb(s: Sub, m: Msg) {
  try {
    await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(m), { TTL: 3600, urgency: 'high' });
    return 'ok' as const;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) return 'gone' as const;
    console.log('push error', e?.statusCode, String(e?.body || e?.message || e).slice(0, 200));
    return 'err' as const;
  }
}

// Android app: Firebase Cloud Messaging HTTP v1, signed with the service account in Vault (fcm_service_account).
let fcmAuth: { token: string; exp: number } | null = null;
async function fcmToken(sa: any) {
  const now = Math.floor(Date.now() / 1000);
  if (fcmAuth && fcmAuth.exp > now + 60) return fcmAuth.token;
  const key = await importPKCS8(sa.private_key, 'RS256');
  const jwt = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(sa.client_email).setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`fcm auth ${res.status}`);
  fcmAuth = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return fcmAuth.token;
}
async function sendFcm(token: string, m: Msg) {
  if (!cfg?.fcm_service_account) { console.log('fcm not configured'); return 'err' as const; }
  try {
    const sa = JSON.parse(cfg.fcm_service_account);
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await fcmToken(sa)}` },
      body: JSON.stringify({ message: {
        token,
        notification: { title: m.title, body: m.body },
        data: { url: m.url, tag: m.tag },
        android: { priority: 'HIGH', ttl: '3600s', notification: { channel_id: 'orders', tag: m.tag, sound: 'default', default_vibrate_timings: true } },
      } }),
    });
    if (res.ok) return 'ok' as const;
    const t = await res.text();
    if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(t)) return 'gone' as const;
    console.log('fcm error', res.status, t.slice(0, 200));
    return 'err' as const;
  } catch (e) { console.log('fcm error', String(e).slice(0, 200)); return 'err' as const; }
}

// iPhone app: Apple Push Notification service with a .p8 key from Vault (apns_key, apns_key_id, apns_team_id).
let apnsAuth: { token: string; iat: number } | null = null;
async function apnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (apnsAuth && now - apnsAuth.iat < 45 * 60) return apnsAuth.token; // Apple wants a new one at most every 20-60 min
  const key = await importPKCS8(cfg!.apns_key, 'ES256');
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: cfg!.apns_key_id }).setIssuer(cfg!.apns_team_id).setIssuedAt(now).sign(key);
  apnsAuth = { token, iat: now };
  return token;
}
async function sendApns(token: string, m: Msg) {
  if (!cfg?.apns_key || !cfg.apns_key_id || !cfg.apns_team_id) { console.log('apns not configured'); return 'err' as const; }
  const host = cfg.apns_sandbox === '1' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  try {
    const res = await fetch(`https://${host}/3/device/${token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${await apnsJwt()}`, 'apns-topic': cfg.apns_bundle_id || 'app.talla.delivery',
        'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'apns-collapse-id': m.tag.slice(0, 64),
      },
      body: JSON.stringify({ aps: { alert: { title: m.title, body: m.body }, sound: 'default' }, url: m.url, tag: m.tag }),
    });
    if (res.ok) return 'ok' as const;
    const t = await res.text();
    if (res.status === 410 || /Unregistered/.test(t)) return 'gone' as const;
    console.log('apns error', res.status, t.slice(0, 200));
    return 'err' as const;
  } catch (e) { console.log('apns error', String(e).slice(0, 200)); return 'err' as const; }
}

// A shop assigned this order to a driver: ring the driver's phone.
async function driverAssigned(db: any, orderId: string) {
  const { data: o } = await db.from('orders')
    .select('id, order_number, total, total_syp, delivery_landmark, restaurants(name), zones(name), drivers(user_id)')
    .eq('id', orderId).single();
  const uid = o?.drivers?.user_id;
  if (!uid) return json({ sent: 0 });
  const { data: subs } = await db.from('push_subscriptions').select('*').eq('user_id', uid).eq('app', 'customer');
  const money = o.total_syp != null ? `${Number(o.total_syp).toLocaleString('ar-SY')} ل.س` : `$${o.total}`;
  const where = [o.zones?.name, o.delivery_landmark].filter(Boolean).join(' · ');
  const payload = JSON.stringify({
    title: `🛵 طلب توصيل #${o.order_number ?? ''}`,
    body: `من ${o.restaurants?.name || 'المحل'}${where ? ` إلى ${where}` : ''} · اقبض ${money}`,
    url: APP_URL.customer,
    tag: `drv-${o.id}`,
  });
  return json(await sendTo(db, subs || [], payload));
}

// The order moved on: tell the customer.
async function statusChanged(db: any, orderId: string) {
  const { data: o } = await db.from('orders')
    .select('id, order_number, status, fulfillment, customer_id, cancel_reason, restaurants(name)')
    .eq('id', orderId).single();
  if (!o?.customer_id) return json({ sent: 0 });
  const pickup = o.fulfillment === 'pickup';
  const shop = o.restaurants?.name || 'المحل';
  const msg: Record<string, [string, string] | null> = {
    accepted: ['👍 انقبل طلبك', `${shop} قبل طلبك وعم يحضّره`],
    ready: pickup ? ['🏪 طلبك جاهز', `فيك تمرق تستلمه من ${shop}`] : null,
    picked_up: ['🛵 طلبك بالطريق', 'السائق طلع لعندك، جهّز الكاش'],
    delivered: pickup ? null : ['✅ وصل طلبك', 'صحتين وعافية! قيّم طلبك من التطبيق'],
    rejected: ['❌ انرفض طلبك', o.cancel_reason ? `السبب: ${o.cancel_reason}` : `${shop} ما قدر يقبل الطلب`],
    cancelled: ['انلغى طلبك', o.cancel_reason ? `السبب: ${o.cancel_reason}` : `طلبك من ${shop} انلغى`],
  };
  const m = msg[o.status];
  if (!m) return json({ sent: 0 });
  const { data: subs } = await db.from('push_subscriptions').select('*').eq('user_id', o.customer_id).eq('app', 'customer');
  const payload = JSON.stringify({
    title: `${m[0]} · #${o.order_number ?? ''}`,
    body: m[1],
    url: `${APP_URL.customer}#/order/${o.id}`,
    tag: `cust-${o.id}`,
  });
  return json(await sendTo(db, subs || [], payload));
}

// Promo notification to every customer who turned notifications on and didn't turn promos off.
const promoUrl = (rid?: string | null) => `${APP_URL.customer}${rid ? `#/r/${rid}` : ''}`;
async function campaign(db: any, id: number) {
  const { data: c } = await db.from('campaigns').select('*').eq('id', id).single();
  if (!c || c.status !== 'sending') return json({ sent: 0 });
  const { data: users } = await db.from('profiles').select('id').eq('role', 'customer').eq('promo_push', true).eq('is_blocked', false);
  const ids = (users || []).map((u: any) => u.id);
  let subs: Sub[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('app', 'customer').in('user_id', ids.slice(i, i + 200));
    subs = subs.concat(data || []);
  }
  const payload = JSON.stringify({ title: c.title, body: c.body, url: promoUrl(c.restaurant_id), tag: `promo-${c.id}` });
  const r = await sendTo(db, subs, payload);
  await db.from('campaigns').update({ status: 'sent', sent_at: new Date().toISOString(), sent_count: r.sent, gone_count: r.gone }).eq('id', c.id);
  return json(r);
}

// Same notification, only to the admin who asked (all their devices).
async function campaignTest(db: any, b: any) {
  if (!b.user_id || !b.title) return json({ error: 'bad request' }, 400);
  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', b.user_id);
  const payload = JSON.stringify({ title: b.title, body: b.body || '', url: promoUrl(b.restaurant_id), tag: `promo-test-${Date.now()}` });
  return json(await sendTo(db, subs || [], payload));
}
