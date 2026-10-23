// This module ships with customer Workers. Private data stays behind the platform API.
import { composeCollectionPage } from './collection-pages-site.js';
// 5 (2026-10-22): the website answers booking partners at its own address, /_booking-api/booking/v1 (partnerApiRoute).
// 6 (2026-10-23): the website serves its own web app at /_app/ when it is on the Web App tier (webAppRoute).
// 7 (2026-10-23): the web app takes file uploads (a CV) and hands files back (/_app/api/upload, /_app/api/file).
// 8 (2026-10-23): the web app shows on the website itself: app components on any page, a sign-in button, public lists.
export const CUSTOMER_RUNTIME_VERSION = 8;
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
// ── The website's own web app ──────────────────────────────────────────────────────────────────────────────────────
// docs/site-web-apps.md. When the platform has published site-integrations/<id>/web-app.json with enabled true (the
// website is on the Web App tier and has an app), the website answers:
//   /_app/ and /<lang>/_app/   the app, drawn inside the website's own page (its header, footer and stylesheet)
//   /_app/assets/<name>        the app's screen code, fetched from the platform by name
//   /_app/api/<action>         the app's API, handed to the platform with this website and its address pinned
// The browser's persona choice (demo) or sign-in (live) rides in its own headers; the platform decides what it means.
const appAssets = new Set(['web-app-ui.js', 'web-app-ui.css', 'web-app-embed.js', 'web-app-embed.css', 'guest-auth.js', 'customer-login.js']);
const APP_BODY_LIMIT = 65536;
const APP_UPLOAD_LIMIT = 10 * 1024 * 1024;
const APP_UPLOAD_TYPES = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain|image\/jpeg|image\/png|application\/octet-stream)(?:;|$)/i;
export function webAppSnapshot(text, siteId) {
  try { const value = JSON.parse(text || '{}'); return value.version === 1 && value.siteId === siteId && value.enabled === true ? value : null; } catch { return null; }
}
export async function webAppRoute(request, env, { siteId, snapshot, shell, platformOrigin } = {}) {
  const url = new URL(request.url), path = url.pathname;
  const page = /^\/(?:([a-z]{2})\/)?_app\/?$/.exec(path);
  if (!page && !path.startsWith('/_app/')) return null;
  if (!snapshot || !origins.includes(platformOrigin)) return null;
  const reply = (message, status) => Response.json({ error: message }, { status, headers: privateHeaders });
  if (path.startsWith('/_app/assets/')) {
    const name = path.slice('/_app/assets/'.length);
    if (!appAssets.has(name)) return reply('Not found.', 404);
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed.', 405);
    try {
      const response = await fetch(new URL(`/${name}`, platformOrigin), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return reply('The app is temporarily unavailable.', 503); }
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: { ...privateHeaders, 'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' } });
    } catch { return reply('The app is temporarily unavailable.', 503); }
  }
  if (path.startsWith('/_app/api/')) {
    const action = path.slice('/_app/api/'.length);
    if (!/^[a-z][a-z-]{1,30}$/.test(action)) return reply('Not found.', 404);
    if (!['GET', 'POST'].includes(request.method)) return reply('Method not allowed.', 405);
    const uploading = action === 'upload';
    if (request.method === 'POST' && (request.headers.get('origin') !== url.origin
      || !(uploading ? APP_UPLOAD_TYPES : /^application\/json(?:;|$)/i).test(request.headers.get('content-type') || ''))) return reply('Use this website to open the app.', 403);
    if (!env.CUSTOMER_ACCOUNT_ACTOR_RATE || !env.CUSTOMER_ACCOUNT_SITE_RATE) return reply('The app is temporarily unavailable.', 503);
    const limits = await Promise.all([env.CUSTOMER_ACCOUNT_ACTOR_RATE.limit({ key: `app:${request.headers.get('cf-connecting-ip') || 'unknown'}` }), env.CUSTOMER_ACCOUNT_SITE_RATE.limit({ key: `app:${siteId}` })]);
    if (limits.some(limit => !limit.success)) return reply('Please wait a moment and try again.', 429);
    const destination = new URL('/api/web-app', platformOrigin);
    for (const key of ['kind', 'id', 'lang', 'demo', 'field']) if (url.searchParams.has(key)) destination.searchParams.set(key, url.searchParams.get(key).slice(0, 80));
    destination.searchParams.set('action', action); destination.searchParams.set('siteId', siteId); destination.searchParams.set('siteOrigin', url.origin);
    let body;
    if (request.method === 'POST') {
      const reader = request.body?.getReader(), chunks = []; let size = 0;
      const limit = uploading ? APP_UPLOAD_LIMIT : APP_BODY_LIMIT;
      if (!reader) return reply('Missing request.', 400);
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); return reply(uploading ? 'The file is larger than 10 MB.' : 'Request is too large.', 413); } chunks.push(value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if (uploading) body = bytes;
        else {
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply('Invalid request.', 400);
          body = JSON.stringify({ ...parsed, action, siteId, siteOrigin: url.origin });
        }
      } catch { return reply('Invalid request.', 400); }
    }
    const persona = String(request.headers.get('x-ww-app-persona') || '');
    try {
      const client = String(request.headers.get('cf-connecting-ip') || '').slice(0, 60);
      const fileName = String(request.headers.get('x-ww-file-name') || '').slice(0, 600);
      const upstream = await fetch(destination, { method: request.method, redirect: 'manual', headers: { 'content-type': uploading ? request.headers.get('content-type') : 'application/json', accept: 'application/json', origin: url.origin,
        ...(client ? { 'x-ww-client-ip': client } : {}), ...(/^[0-9a-f-]{36}$/i.test(persona) ? { 'x-ww-app-persona': persona } : {}),
        ...(uploading && fileName ? { 'x-ww-file-name': fileName } : {}),
        ...(request.headers.get('authorization') ? { authorization: request.headers.get('authorization') } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(90000) });
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return reply('The app is temporarily unavailable.', 503); }
      // A file comes back as itself, to be saved, never shown in the website's frame.
      if (action === 'file' && upstream.ok) {
        return new Response(upstream.body, { status: 200, headers: { ...privateHeaders, 'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'content-disposition': upstream.headers.get('content-disposition') || 'attachment' } });
      }
      return new Response(upstream.body, { status: upstream.status, headers: { ...privateHeaders, 'content-type': 'application/json; charset=utf-8' } });
    } catch { return reply('The app is temporarily unavailable.', 503); }
  }
  if (!page) return reply('Not found.', 404);
  if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed.', 405);
  const languages = Array.isArray(snapshot.languages) && snapshot.languages.length ? snapshot.languages : ['tr'];
  const lang = page[1] && languages.includes(page[1]) ? page[1] : languages[0];
  if (page[1] && !languages.includes(page[1])) return new Response(null, { status: 302, headers: { ...privateHeaders, location: '/_app/' } });
  // The website's own page in that language is the frame; its first language lives at /.
  let home = await shell(lang === languages[0] ? '/' : `/${lang}/`);
  if (!home.ok && lang !== languages[0]) home = await shell('/');
  if (!home.ok || !/text\/html/.test(home.headers.get('content-type') || '')) return reply('The app is temporarily unavailable.', 503);
  if (!/<main(?:\s|>)/i.test(await home.clone().text())) return reply('The website needs a page layout before its app can be shown.', 409);
  const title = (snapshot.name && (snapshot.name[lang] || Object.values(snapshot.name)[0])) || 'App';
  const body = `<section class="ww-app" data-ww-app-site="${escape(siteId)}" data-ww-app-lang="${escape(lang)}" data-ww-app-languages="${escape(languages.join(','))}"><div id="ww-app-root" aria-live="polite"><p class="ww-app-loading">${lang === 'tr' ? 'Yükleniyor…' : 'Loading…'}</p></div><noscript>${lang === 'tr' ? 'Uygulamayı kullanmak için JavaScript gerekir.' : 'Enable JavaScript to use the app.'}</noscript></section>`;
  const head = '<meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/_app/assets/web-app-ui.css"><script type="module" src="/_app/assets/web-app-ui.js"></script>';
  const composed = composeCollectionPage(home, { head, body }, { title, origin: url.origin, canonical: new URL(path, url.origin).href, keepMain: true });
  const headers = new Headers(composed.headers); for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  headers.delete('content-security-policy');
  headers.set('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://esm.sh; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  return new Response(request.method === 'HEAD' ? null : composed.body, { headers });
}
// ── The web app on the website's own pages ─────────────────────────────────────────────────────────────────────────
// Any page may hold app components, written by the owner's assistant in the website's own markup:
//   <div data-ww-app="list" data-kind="job" data-actions="refer,apply">[<template> a card of its own </template>]</div>
//   <a data-ww-app="signin">…</a>    <a data-ww-app-action="apply" data-kind="job" data-record="<id>">…</a>
// /_app/assets/web-app-embed.js fills them in from the app's public lists. Besides those, the owner's choices place a
// sign-in button in the header and lists on the pages the blueprint names (into a selector, or at the end of <main>).
// This plans what a page gets; addWebAppEntry applies it.
export function webAppPagePlan(snapshot, pathname) {
  // Every page of an app's website gets the loader, so components the assistant wrote come alive with or without
  // any placement the owner chose.
  if (!snapshot) return null;
  const presentation = snapshot.presentation || {};
  const languages = Array.isArray(snapshot.languages) && snapshot.languages.length ? snapshot.languages : ['tr'];
  const path = String(pathname || '/');
  if (/^\/(?:[a-z]{2}\/)?_app(?:\/|$)/.test(path)) return null;
  const lang = languages.slice(1).find((code) => path === `/${code}` || path.startsWith(`/${code}/`)) || languages[0];
  const appPath = lang === languages[0] ? '/_app/' : `/${lang}/_app/`;
  const header = presentation.header?.on ? { href: appPath, label: String(presentation.header.label?.[lang] || presentation.header.label?.[languages[0]] || 'App').slice(0, 40) } : null;
  const normal = (value) => String(value || '').replace(/\/?$/, '/');
  const lists = (presentation.lists || []).filter((item) => item.on && item.pages?.[lang] && normal(item.pages[lang]) === normal(path))
    .map((item) => ({ kind: String(item.kind), into: item.into || null }));
  return { lang, appPath, header, lists };
}

export function addWebAppEntry(response, snapshot, siteId, pathname) {
  if (!snapshot || typeof HTMLRewriter === 'undefined') return response;
  const plan = webAppPagePlan(snapshot, pathname);
  if (!plan) return response;
  const marker = (kind) => `<div class="ww-app-embed-list" data-ww-app="list" data-kind="${escape(kind)}"></div>`;
  let header = 'pending', content = false, menu = false, nav = false, linked = false, itemClass = '', linkClass = '', itemSeen = false, linkSeen = false;
  const placed = new Set();
  const cleanClass = value => String(value || '').split(/\s+/).filter(token => /^[a-zA-Z0-9_-]+$/.test(token) && !['active', 'current', 'selected', 'is-active', 'is-current'].includes(token)).join(' ');
  const link = () => ` <a${linkClass ? ` class="${linkClass}"` : ''} href="${escape(plan.header.href)}" data-ww-app="signin">${escape(plan.header.label)}</a>`;
  let rewriter = new HTMLRewriter()
    .on('head', { element(element) { element.onEndTag(end => end.before('<link rel="stylesheet" href="/_app/assets/web-app-embed.css">', { html: true })); } })
    .on('body', { element(element) { element.append(`<script type="module" src="/_app/assets/web-app-embed.js" data-ww-app-site="${escape(siteId)}" data-ww-app-lang="${escape(plan.lang)}" data-ww-app-path="${escape(plan.appPath)}"></script>`, { html: true }); } });
  if (plan.header) {
    rewriter = rewriter.on('main, article', { element() { content = true; } })
      .on('header', { element(element) {
        if (header !== 'pending' || content) return;
        header = 'open'; element.onEndTag(end => { if (!linked && !menu && !nav) end.before(link(), { html: true }); header = 'closed'; });
      } })
      .on('header nav', { element(element) {
        if (header !== 'open' || nav) return;
        nav = true; element.onEndTag(end => { if (!linked && !menu) end.before(link(), { html: true }); });
      } })
      .on('header nav ul, header ul.nav-list, header ul#primary-nav, header ul.navigation', { element(element) {
        if (header !== 'open' || menu) return;
        menu = true; element.onEndTag(end => { if (!linked) { linked = true; end.before(`<li${itemClass ? ` class="${itemClass}"` : ''}>${link()}</li>`, { html: true }); } });
      } })
      .on('header nav ul > li, header ul.nav-list > li, header ul#primary-nav > li, header ul.navigation > li', { element(element) {
        if (header === 'open' && !itemSeen) { itemSeen = true; itemClass = cleanClass(element.getAttribute('class')); }
      } })
      .on('header a[href]', { element(element) {
        if (header !== 'open') return;
        if (element.getAttribute('data-ww-app') === 'signin' || /^\/(?:[a-z]{2}\/)?_app\/?$/.test(element.getAttribute('href') || '')) linked = true;
      } })
      .on('header nav a[href], header ul.nav-list a[href], header ul#primary-nav a[href]', { element(element) {
        if (header === 'open' && !linkSeen) { linkSeen = true; linkClass = cleanClass(element.getAttribute('class')); }
      } });
  }
  for (const list of plan.lists) {
    const into = list.into || 'main';
    rewriter = rewriter.on(into, { element(element) {
      if (placed.has(list)) return;
      placed.add(list);
      element.append(marker(list.kind), { html: true });
    } });
  }
  return rewriter.transform(response);
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
