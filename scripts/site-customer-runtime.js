// This module ships with customer Workers. Private data stays behind the platform API.
import { composeCollectionPage } from './collection-pages-site.js';
// 5 (2026-10-22): the website answers booking partners at its own address, /_booking-api/booking/v1 (partnerApiRoute).
export const CUSTOMER_RUNTIME_VERSION = 5;
const privateHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff' };
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const origins = ['https://jaybirddigital.com', 'https://dev.jaybirddigital.com', 'https://wheelerswebsites-staging.jaybirddigital.workers.dev'];
// The booking page's bundle is the portal's: its modules and stylesheets are fetched from the platform origin by name.
const assets = new Set(['customer-account.js', 'customer-account.css', 'customer-session.js', 'customer-login.js', 'guest-auth.js', 'scheduler-ui.js', 'booking.js', 'booking-ui.js', 'booking.css',
  'scheduler-intake.js', 'scheduler-policy.js', 'scheduler-policy-rules.js', 'scheduler.css', 'portal.css', 'jaybird-logo.png']);
// ── Booking partners at the website's own address ──────────────────────────────────────────────────────────────────
// An outside booking channel (docs/booking-partner-api.md) may call the platform's /booking/v1 or, with the same paths and
// the same key, the property's own address: https://<website>/_booking-api/booking/v1/... . This hands the call to the
// platform, which runs the one handler both addresses share (src/scheduler/partner-api.js), and tells it which website
// the call arrived at in x-ww-site-id so that a key from another website is refused there (a pin can only narrow a key,
// never widen it, so the platform needs no proof that the header came from a Worker). The method, the query, the body
// and the Authorization header go through as they came; nothing here reads a cookie or caches an answer.
//
// What is answered here, in the API's own error shape and without a call to the platform: an address that is not under
// /_booking-api/booking/v1, no key of the right shape, and a body past the API's 20 KB. Every other answer, a method the
// API does not use included, is the platform's.
export const PARTNER_SITE_PREFIX = '/_booking-api';
const PARTNER_PLATFORM_PATH = '/booking/v1';
const PARTNER_BODY_LIMIT = 20000;
// The shape of a key (src/scheduler/partner-keys.js KEY_PATTERN); a test keeps the two equal.
const PARTNER_KEY = /^Bearer\s+wwbk_[A-Za-z0-9_-]{43}$/i;
const PARTNER_PASS_BACK = ['content-type', 'x-request-id', 'x-booking-api-version', 'idempotent-replayed', 'retry-after', 'allow', 'www-authenticate'];
export async function partnerApiRoute(request, env, { siteId, platformOrigin } = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (path !== PARTNER_SITE_PREFIX && !path.startsWith(`${PARTNER_SITE_PREFIX}/`)) return null;
  const requestId = crypto.randomUUID();
  const reply = (status, code, message, extra = {}) => Response.json({ error: { code, message }, request_id: requestId },
    { status, headers: { ...privateHeaders, 'x-request-id': requestId, 'x-booking-api-version': '1', ...extra } });
  const rest = path.slice(PARTNER_SITE_PREFIX.length);
  if (!siteId || (rest !== PARTNER_PLATFORM_PATH && !rest.startsWith(`${PARTNER_PLATFORM_PATH}/`))) return reply(404, 'not_found', 'There is nothing at this address.');
  if (!PARTNER_KEY.test(request.headers.get('authorization') || '')) return reply(401, 'unauthorized', 'Send your API key as "Authorization: Bearer <key>". Ask the property for a key.', { 'www-authenticate': 'Bearer' });
  if (!origins.includes(platformOrigin)) return reply(503, 'temporarily_unavailable', 'We could not complete this. Try again in a moment.');
  let body;
  if (request.method === 'POST' || request.method === 'PATCH') {
    if (Number(request.headers.get('content-length') || 0) > PARTNER_BODY_LIMIT) { await request.body?.cancel(); return reply(413, 'too_large', 'The request is over 20 KB.'); }
    const reader = request.body?.getReader(), chunks = []; let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > PARTNER_BODY_LIMIT) { await reader.cancel(); return reply(413, 'too_large', 'The request is over 20 KB.'); }
          chunks.push(value);
        }
      } catch { return reply(400, 'invalid_request', 'The request could not be read.'); }
      body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    }
  }
  const destination = new URL(`${PARTNER_PLATFORM_PATH}${rest.slice(PARTNER_PLATFORM_PATH.length)}`, platformOrigin);
  if (destination.origin !== platformOrigin || (destination.pathname !== PARTNER_PLATFORM_PATH && !destination.pathname.startsWith(`${PARTNER_PLATFORM_PATH}/`))) return reply(404, 'not_found', 'There is nothing at this address.');
  destination.search = url.search;
  // Only these travel; anything else the caller sent, x-ww-* included, stays here. The client address is advice for the
  // platform's budgets, as on the account routes, never a security bound.
  const client = String(request.headers.get('cf-connecting-ip') || '').slice(0, 60);
  const headers = { authorization: request.headers.get('authorization'), accept: request.headers.get('accept') || 'application/json', 'x-ww-site-id': siteId,
    ...(request.headers.get('content-type') && body ? { 'content-type': request.headers.get('content-type') } : {}),
    ...(request.headers.get('user-agent') ? { 'user-agent': String(request.headers.get('user-agent')).slice(0, 200) } : {}),
    ...(client ? { 'x-ww-client-ip': client } : {}) };
  try {
    const upstream = await fetch(destination, { method: request.method, redirect: 'manual', headers, ...(body && body.byteLength ? { body } : {}), signal: AbortSignal.timeout(25000) });
    // A redirect, or a failure that is not the API's own (an error page from in front of it), is not an answer to pass on.
    if ((upstream.status >= 300 && upstream.status < 400) || (upstream.status >= 500 && !/json/i.test(upstream.headers.get('content-type') || ''))) {
      await upstream.body?.cancel(); return reply(503, 'temporarily_unavailable', 'We could not complete this. Try again in a moment.');
    }
    const out = new Headers(privateHeaders);
    for (const name of PARTNER_PASS_BACK) if (upstream.headers.has(name)) out.set(name, upstream.headers.get(name));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch { return reply(503, 'temporarily_unavailable', 'We could not complete this. Try again in a moment.'); }
}
export function customerAccountSnapshot(text, siteId) {
  try { const value = JSON.parse(text || '{}'); return value.version === 1 && value.siteId === siteId && value.enabled === true ? value : null; } catch { return null; }
}
export async function customerAccountRoute(request, env, { siteId, snapshot, shell, platformOrigin } = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (!snapshot || !origins.includes(platformOrigin)) return null;
  const reply = (message, status) => Response.json({ error: message }, { status, headers: privateHeaders });
  if (path.startsWith('/_account/assets/')) {
    const name = path.slice('/_account/assets/'.length);
    if (!assets.has(name)) return reply('Not found.', 404);
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed.', 405);
    try {
      const response = await fetch(new URL(name === 'jaybird-logo.png' ? '/img/jaybird-logo.png' : `/${name}`, platformOrigin), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return reply('Account assets are temporarily unavailable.', 503); }
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: { ...privateHeaders, 'content-type': name === 'jaybird-logo.png' ? 'image/png' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' } });
    } catch { return reply('Account assets are temporarily unavailable.', 503); }
  }
  if (path.startsWith('/_account/api/')) {
    const action = path.slice('/_account/api/'.length);
    if (!['config', 'account', 'bookings'].includes(action)) return reply('Not found.', 404);
    if (!['GET', 'POST'].includes(request.method) || (action === 'config' && request.method !== 'GET')) return reply('Method not allowed.', 405);
    if (request.method === 'POST' && (request.headers.get('origin') !== url.origin || !/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || ''))) return reply('Use this website to access your account.', 403);
    if (!env.CUSTOMER_ACCOUNT_ACTOR_RATE || !env.CUSTOMER_ACCOUNT_SITE_RATE) return reply('Account access is temporarily unavailable.', 503);
    const limits = await Promise.all([env.CUSTOMER_ACCOUNT_ACTOR_RATE.limit({ key: `account:${request.headers.get('cf-connecting-ip') || 'unknown'}` }), env.CUSTOMER_ACCOUNT_SITE_RATE.limit({ key: `account:${siteId}` })]);
    if (limits.some(limit => !limit.success)) return reply('Please wait a moment and try again.', 429);
    const destination = new URL(action === 'bookings' ? '/api/guest-scheduler' : '/api/customer-account', platformOrigin);
    for (const key of ['action', 'section', 'cursor']) if (url.searchParams.has(key)) destination.searchParams.set(key, url.searchParams.get(key));
    if (action === 'config') destination.searchParams.set('action', 'config');
    destination.searchParams.set('siteId', siteId); destination.searchParams.set('siteOrigin', url.origin);
    let body;
    if (request.method === 'POST') {
      const reader = request.body?.getReader(), chunks = []; let size = 0;
      if (!reader) return reply('Missing request.', 400);
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); return reply('Request is too large.', 413); } chunks.push(value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply('Invalid request.', 400);
        body = JSON.stringify({ ...parsed, siteId, siteOrigin: url.origin });
      } catch { return reply('Invalid request.', 400); }
    }
    try {
      // The connecting address rides along as advice for the platform's request budgets (it is never a security bound).
      const client = String(request.headers.get('cf-connecting-ip') || '').slice(0, 60);
      const upstream = await fetch(destination, { method: request.method, redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json', origin: url.origin,
        ...(client ? { 'x-ww-client-ip': client } : {}), ...(request.headers.get('authorization') ? { authorization: request.headers.get('authorization') } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(20000) });
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return reply('Your account is temporarily unavailable.', 503); }
      return new Response(upstream.body, { status: upstream.status, headers: { ...privateHeaders, 'content-type': 'application/json; charset=utf-8' } });
    } catch { return reply('Your account is temporarily unavailable.', 503); }
  }
  const booking = /^\/_booking\/?$/.test(path);
  if (!booking && !/^\/_account(?:\/(?:stays|reservations|events|purchases|callback))?\/?$/.test(path) && !/^\/_guest-account\/?$/.test(path)) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed.', 405);
  if (/^\/_guest-account/.test(path)) return new Response(null, { status: 302, headers: { ...privateHeaders, location: '/_account/' } });
  // Existing static pages at the reserved route need an explicit integration choice.
  if (env.ASSETS) {
    const existing = await env.ASSETS.fetch(new Request(new URL(`${path.replace(/\/$/, '')}/index.html`, url.origin)));
    const conflict = existing.ok; await existing.body?.cancel();
    if (conflict) return reply('This website already has a page at this account route. Contact the business to connect its account pages.', 409);
  }
  const home = await shell();
  if (!home.ok || !/text\/html/.test(home.headers.get('content-type') || '')) return reply('The website account page is temporarily unavailable.', 503);
  const html = await home.clone().text();
  if (!/<main(?:\s|>)/i.test(html)) return reply('The website needs an account layout before accounts can be displayed.', 409);
  const section = path.split('/')[2] || 'summary';
  const body = `<section class="ww-customer-account" data-ww-customer-site="${escape(siteId)}" data-ww-account-section="${escape(section)}"><nav aria-label="Customer account"><a href="/">Website</a> <a href="/_account/">My account</a> <a id="website-link" href="/" hidden>Visit website</a></nav><h1 id="title">${booking ? 'Reservations' : 'My account'}</h1><p id="intro">Loading…</p><div id="content"></div><p id="status" role="status" aria-live="polite"></p><noscript>Enable JavaScript to sign in and manage your account.</noscript></section>`;
  // The booking page wears the same stylesheets mounted and standalone (scheduler.css, booking.css) over the site's own
  // customer-account theme; portal.css stays on the portal, since its :root tokens would restyle the website around it.
  const head = `<meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/_account/assets/customer-account.css">${booking ? '<link rel="stylesheet" href="/_account/assets/scheduler.css"><link rel="stylesheet" href="/_account/assets/booking.css">' : ''}<script type="module" src="/_account/assets/${booking ? 'booking.js' : 'customer-account.js'}"></script>`;
  const page = composeCollectionPage(home, { head, body }, { title: booking ? 'Reservations' : 'My account', origin: url.origin, canonical: new URL(path, url.origin).href, keepMain: true });
  const headers = new Headers(page.headers); for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  headers.delete('content-security-policy');
  // Preserve arbitrary website assets while limiting the customer component's auth connections.
  headers.set('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://esm.sh https://challenges.cloudflare.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://www.recaptcha.net https://js.stripe.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://esm.sh; frame-src https://challenges.cloudflare.com https://www.google.com/recaptcha/ https://www.recaptcha.net https://*.stripe.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  return new Response(request.method === 'HEAD' ? null : page.body, { headers });
}
export function addCustomerAccountNav(response, snapshot, siteId) {
  if (!snapshot || typeof HTMLRewriter === 'undefined') return response;
  let header = 'pending', content = false, menu = false, nav = false, linked = false, itemClass = '', linkClass = '', itemSeen = false, linkSeen = false, styled = false;
  const cleanClass = value => String(value || '').split(/\s+/).filter(token => /^[a-zA-Z0-9_-]+$/.test(token)
    && !['active', 'current', 'selected', 'is-active', 'is-current'].includes(token)).join(' ');
  const link = () => ` <a${linkClass ? ` class="${linkClass}"` : ''} href="/_account/" data-ww-account-link>My account</a>`;
  return new HTMLRewriter().on('main, article', { element() { content = true; } })
    .on('header', { element(element) {
      if (header !== 'pending' || content) return;
      header = 'open'; element.onEndTag(end => { if (!linked && !menu && !nav) end.before(link(), { html: true }); header = 'closed'; });
    } })
    .on('header nav', { element(element) {
      if (header !== 'open' || nav) return;
      nav = true; element.onEndTag(end => { if (!linked && !menu) end.before(link(), { html: true }); });
    } })
    .on('header nav ul, header ul.nav-list, header ul#primary-nav', { element(element) {
      if (header !== 'open' || menu) return;
      menu = true; element.setAttribute('data-ww-customer-nav', ''); element.onEndTag(end => { if (!linked) end.before(`<li${itemClass ? ` class="${itemClass}"` : ''}>${link()}</li>`, { html: true }); });
    } })
    .on('header nav ul > li, header ul.nav-list > li, header ul#primary-nav > li', { element(element) {
      if (header === 'open' && !itemSeen) { itemSeen = true; itemClass = cleanClass(element.getAttribute('class')); }
    } })
    .on('header a[href]', { element(element) {
      if (header !== 'open') return;
      if (/^\/_account\/?$/.test(element.getAttribute('href') || '')) { linked = true; element.setAttribute('data-ww-account-link', ''); }
    } })
    .on('header nav a[href], header ul.nav-list a[href], header ul#primary-nav a[href]', { element(element) {
      if (header === 'open' && !linkSeen) { linkSeen = true; linkClass = cleanClass(element.getAttribute('class')); }
    } })
    .on('head', { element(element) { element.onEndTag(end => { if (!styled) end.before('<link rel="stylesheet" href="/_account/assets/customer-account.css">', { html: true }); }); } })
    .on('link[href="/_account/assets/customer-account.css"]', { element() { styled = true; } })
    .on('body', { element(element) { element.append(`<script type="module" src="/_account/assets/customer-session.js" data-ww-customer-site="${escape(siteId)}"></script>`, { html: true }); } }).transform(response);
}
