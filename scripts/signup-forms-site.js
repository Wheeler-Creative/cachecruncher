// Sign-up forms on the website (docs/customer-accounts/sign-up-forms.md). The platform publishes a website's live forms to
// site-integrations/<site>/signup-forms.json (src/customer-accounts/sign-ups.js publishSignupFormsSnapshot), and the
// website's own server, while it serves a page:
// - answers /join/<slug>/, the form's own page, inside the website's header, footer and styles: the link to text or to
//   print as a QR code;
// - draws a form where a page's content holds <div data-ww-signup="<slug>"></div>, and above the site's footer on the
//   pages the owner chose;
// - adds one form as a pop-up on the pages the owner chose: it opens once a visitor has been on the page a few seconds,
//   not again for the days the owner chose once they close it, and never again once they sign up;
// - answers /join/confirm/, the link in the confirmation email, with the platform's page drawn in the website's look.
// Every form posts to the website's /api/join (scripts/scaffold-site-build.mjs handleSignupJoin) with the site's bot
// check. Everything comes from the website's own address, so a strict Content-Security-Policy ('self') still allows it.

import { buttonClass, wordsFor } from "./signups-site.js";
import { composeCollectionPage } from "./collection-pages-site.js";

export const SIGNUP_FORMS_RENDER_VERSION = 1;
export const SIGNUP_FORMS_SCRIPT_PATH = "/_ww/signup-forms.js";
export const JOIN_PREFIX = "/join/";
export const JOIN_CONFIRM_PATH = "/join/confirm/";
// Form addresses the website keeps for itself.
export const RESERVED_SLUGS = Object.freeze(["confirm"]);
const PLATFORM_ORIGINS = ["https://jaybirddigital.com", "https://dev.jaybirddigital.com", "https://wheelerswebsites-staging.jaybirddigital.workers.dev"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Pages a drawn form or a pop-up does not belong on: buying, the customer's own account, the join pages themselves.
const SKIP = /^\/(?:checkout|cart|account|orders|_account|_booking|_ww|api|join)(?:\/|$)/;

const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
const whole = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);

// One spelling for a page's address: "/About", "/about/", "/about.html" and "/about/index.html" are one page.
export function pageKey(path) {
  let value = String(path ?? "").split(/[?#]/)[0];
  try { value = decodeURI(value); } catch { /* keep it as written */ }
  value = value.replace(/\/index\.html?$/i, "/").replace(/\.html?$/i, "").replace(/\/+$/, "");
  return (value || "/").toLowerCase();
}
const pagesOf = (value) => (value === "all" ? "all"
  : Array.isArray(value) ? [...new Set(value.slice(0, 20).filter((path) => typeof path === "string" && path.startsWith("/")).map(pageKey))] : []);
const onPage = (pages, key) => pages === "all" || (Array.isArray(pages) && pages.includes(key));

function parseForm(entry) {
  const id = String(entry?.id || "").toLowerCase(), slug = String(entry?.slug || "");
  if (!UUID.test(id) || !SLUG.test(slug) || RESERVED_SLUGS.includes(slug)) return null;
  const display = entry.display && typeof entry.display === "object" && !Array.isArray(entry.display) ? entry.display : {};
  const sectionPages = display.section ? pagesOf(display.section.pages) : [];
  const popupPages = display.popup ? pagesOf(display.popup.pages) : [];
  return {
    id, slug,
    heading: line(entry.heading, 80) || "Join our list", intro: line(entry.intro, 300), button: line(entry.button, 40) || "Sign up",
    askName: entry.askName === true, askPhone: entry.askPhone === true,
    done: line(entry.done, 300) || "Check your email to confirm your address.",
    joinsNews: entry.joinsNews === true, promise: line(entry.promise, 200),
    section: sectionPages,
    popup: popupPages === "all" || popupPages.length
      ? { pages: popupPages, delay: whole(display.popup.delay, 0, 60, 5), again: whole(display.popup.again, 1, 90, 30) } : null
  };
}

// The published file, read strictly: a file for another website, or one whose forms cannot take sign-ups yet (the
// website holds no sign-up key), draws nothing.
export function parseSignupForms(text, siteId = "") {
  const none = { ready: false, siteName: "", forms: [] };
  try {
    const value = typeof text === "string" ? (text ? JSON.parse(text) : null) : text;
    if (!value || value.version !== 1 || value.ready !== true || (siteId && value.siteId !== siteId)) return none;
    const forms = (Array.isArray(value.forms) ? value.forms : []).slice(0, 50).map(parseForm).filter(Boolean);
    return { ready: true, siteName: line(value.siteName, 80), forms };
  } catch { return none; }
}

// What a page gets: the forms drawn above its footer, and its pop-up (one, and never a form already drawn there).
export function signupFormsFor(snapshot, pathname = "/") {
  if (!snapshot?.ready || !snapshot.forms?.length || SKIP.test(String(pathname))) return { sections: [], popup: null };
  const key = pageKey(pathname);
  const sections = snapshot.forms.filter((form) => onPage(form.section, key));
  const popup = snapshot.forms.find((form) => form.popup && onPage(form.popup.pages, key) && !sections.includes(form)) || null;
  return { sections, popup };
}

const MORE = {
  en: { name: "Name", phone: "Phone number", close: "Close",
    news: (name) => `You'll also get news${name ? ` from ${name}` : ""} by email. Every email has a link to stop.` },
  tr: { name: "Ad soyad", phone: "Telefon numarası", close: "Kapat",
    news: (name) => `${name ? `${name} haberlerini` : "Haberlerimizi"} de e-postayla alacaksınız. Her e-postada abonelikten çıkma bağlantısı vardır.` },
  de: { name: "Name", phone: "Telefonnummer", close: "Schließen",
    news: (name) => `Sie erhalten außerdem Neuigkeiten${name ? ` von ${name}` : ""} per E-Mail. Jede E-Mail enthält einen Link zum Abmelden.` },
  es: { name: "Nombre", phone: "Teléfono", close: "Cerrar",
    news: (name) => `También recibirás novedades${name ? ` de ${name}` : ""} por correo. Cada correo trae un enlace para darte de baja.` },
  fr: { name: "Nom", phone: "Téléphone", close: "Fermer",
    news: (name) => `Vous recevrez aussi les nouvelles${name ? ` de ${name}` : ""} par e-mail. Chaque e-mail contient un lien pour vous désinscrire.` }
};
const moreFor = (language) => MORE[String(language || "en").slice(0, 2).toLowerCase()] || MORE.en;

export const SIGNUP_FORMS_STYLE = "<style>.ww-join{padding:clamp(2rem,5vw,3.5rem) 1rem}.ww-join-inner{max-width:34rem;margin:0 auto}"
  + ".ww-join h1,.ww-join h2,.ww-join-popup h2{margin:0 0 .6rem;font-size:clamp(1.3rem,2.6vw,1.7rem)}.ww-join-page h1{font-size:clamp(1.6rem,4vw,2.3rem)}"
  + ".ww-join-intro{margin:0 0 1.1rem}.ww-join-offer{margin:0 0 1.1rem;font-weight:600}"
  + ".ww-join-form{display:grid;gap:.75rem}.ww-join-field{display:grid;gap:.3rem;font-size:.95em}"
  + ".ww-join-field input{font:inherit;padding:.7em .9em;border:1px solid rgba(0,0,0,.3);border-radius:.4em;background:#fff;color:#111;min-width:0}"
  + ".ww-join-form button[type=submit]{justify-self:start}.ww-join-form button[type=submit]:not([class]){font:inherit;padding:.75em 1.5em;border:0;border-radius:.4em;background:#1f2937;color:#fff;cursor:pointer}"
  + ".ww-join-note{margin:0;font-size:.88em;opacity:.85}.ww-join-status{margin:0;font-size:.95em}.ww-join-status:empty{display:none}"
  + ".ww-join-done{font-size:1.05em;margin:0}.ww-join-hidden{position:absolute!important;left:-10000px;width:1px;height:1px;overflow:hidden}"
  + ".ww-join-popup{width:min(30rem,calc(100% - 2rem));padding:clamp(1.5rem,4vw,2.2rem);border:0;border-radius:.8rem;box-shadow:0 1.2rem 3rem rgba(0,0,0,.3)}"
  + ".ww-join-popup::backdrop{background:rgba(0,0,0,.45)}.ww-join-close{position:absolute;top:.5rem;right:.6rem;font:inherit;font-size:1.6rem;line-height:1;"
  + "padding:.2rem .5rem;border:0;background:none;color:inherit;cursor:pointer}"
  + ".ww-join-confirm .code{display:inline-block;margin:.2rem 0 .6rem;padding:.6rem 1rem;border:2px dashed currentColor;border-radius:.5rem;"
  + "font-size:1.6rem;font-weight:700;letter-spacing:.06em}.ww-join-confirm form{margin:1rem 0}</style>";
const script = () => `<script src="${SIGNUP_FORMS_SCRIPT_PATH}?v=${SIGNUP_FORMS_RENDER_VERSION}" defer data-ww-join-script></script>`;

// One form. formCheck is the site's bot check for "join" (scripts/form-check-rewriter.js), drawn by its Worker; n keeps
// the ids of several forms on one page apart.
export function renderJoinForm(form, { n = 1, formCheck = "", look = "", language = "en", siteName = "" } = {}) {
  const words = wordsFor(language), more = moreFor(language), id = `ww-join-${n}`;
  const check = String(formCheck || "").replace('<div class="cf-turnstile"', `<div id="${id}-check" class="cf-turnstile"`);
  const field = (name, label, type, autocomplete, most) => `<label class="ww-join-field" for="${id}-${name}"><span>${escape(label)}</span>`
    + `<input id="${id}-${name}" type="${type}" name="${name}" autocomplete="${autocomplete}" maxlength="${most}" required></label>`;
  return `<form class="ww-join-form" method="post" action="/api/join" data-ww-join-form="${form.id}" novalidate`
    + ` data-ww-sending="${escape(words.sending)}" data-ww-done="${escape(form.done)}" data-ww-failed="${escape(words.failed)}">`
    + `<input type="hidden" name="formId" value="${form.id}">`
    + (form.askName ? field("name", more.name, "text", "name", 200) : "")
    + field("email", words.email, "email", "email", 320)
    + (form.askPhone ? field("phone", more.phone, "tel", "tel", 60) : "")
    + `<label class="ww-join-hidden" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>`
    + `<button type="submit"${look ? ` class="${escape(look)}"` : ""}>${escape(form.button)}</button>`
    + (form.joinsNews ? `<p class="ww-join-note">${escape(more.news(siteName))}</p>` : "")
    + check
    + `<p class="ww-join-status" role="status" aria-live="polite"></p></form>`;
}

// The form with its heading and words: on its own page, as a section of another page, or as a pop-up.
export function renderJoinBlock(form, place, options = {}) {
  const n = options.n || 1, title = `ww-join-${n}-title`;
  const words = form.intro ? `<p class="ww-join-intro">${escape(form.intro)}</p>` : form.promise ? `<p class="ww-join-offer">${escape(form.promise)}</p>` : "";
  const heading = `<${place === "page" ? "h1" : "h2"} id="${title}">${escape(form.heading)}</${place === "page" ? "h1" : "h2"}>`;
  const inner = heading + words + renderJoinForm(form, options);
  if (place === "popup") {
    return `<dialog class="ww-join-popup" data-ww-join-popup="${form.id}" data-ww-delay="${form.popup?.delay ?? 5}" data-ww-again="${form.popup?.again ?? 30}" aria-labelledby="${title}">`
      + `<button type="button" class="ww-join-close" data-ww-join-close aria-label="${escape(moreFor(options.language).close)}">×</button>${inner}</dialog>`;
  }
  return `<section class="ww-join${place === "page" ? " ww-join-page" : ""}" data-ww-join-drawn aria-labelledby="${title}"><div class="ww-join-inner">${inner}</div></section>`;
}

// The class a call-to-action button in a page's content wears (signups-site.js buttonClass), for a page given whole.
export function pageButtonClass(html) {
  const text = String(html || ""), start = text.search(/<main[\s>]/i);
  for (const match of (start >= 0 ? text.slice(start) : text).matchAll(/<(?:a|button)\b[^>]*\bclass=["']([^"']*(?:btn|button)[^"']*)["']/gi)) {
    const look = buttonClass(match[1]);
    if (look) return look;
  }
  return "";
}

// The page with its forms drawn: in the places its content holds, above the site's footer where the owner chose, and its
// pop-up at the end. formCheck is the site's bot check for "join".
export function addSignupForms(response, snapshot, { pathname = "/", formCheck = "", language = "en" } = {}) {
  if (!snapshot?.ready || !snapshot.forms?.length || typeof HTMLRewriter === "undefined") return response;
  if (!response?.ok || !String(response.headers?.get?.("content-type") || "").includes("text/html")) return response;
  const here = signupFormsFor(snapshot, pathname);
  const bySlug = new Map(snapshot.forms.map((form) => [form.slug, form]));
  const drawn = new Set();
  let inside = 0, placed = false, look = null, n = 0;
  const draw = (form, place) => {
    drawn.add(form.id);
    n += 1;
    return (n === 1 ? SIGNUP_FORMS_STYLE : "") + renderJoinBlock(form, place, { n, formCheck, look: look || "", language, siteName: snapshot.siteName });
  };
  const sections = () => here.sections.filter((form) => !drawn.has(form.id)).map((form) => draw(form, "section")).join("");
  return new HTMLRewriter()
    .on("main, article", { element(element) {
      inside += 1;
      element.onEndTag(() => { inside -= 1; });
    } })
    .on('a[class*="btn"], button[class*="btn"], a[class*="button"], button[class*="button"]', { element(element) {
      if (look === null && inside > 0) look = buttonClass(element.getAttribute("class")) || null;
    } })
    .on("[data-ww-signup]", { element(element) {
      const form = bySlug.get(String(element.getAttribute("data-ww-signup") || "").trim());
      if (!form || drawn.has(form.id)) return;
      element.replace(draw(form, "section"), { html: true });
    } })
    .on("footer", { element(element) {
      if (placed || inside > 0) return;
      placed = true;
      const html = sections();
      if (html) element.before(html, { html: true });
    } })
    .on("body", { element(element) {
      element.onEndTag((end) => {
        let html = placed ? "" : sections();
        placed = true;
        if (here.popup && !drawn.has(here.popup.id)) html += draw(here.popup, "popup");
        if (n) html += script();
        if (html) end.before(html, { html: true });
      });
    } })
    .transform(response);
}

const html = (headers = {}) => ({ "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", ...headers });
const privately = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
const shellOf = async (shell) => {
  const home = shell ? await Promise.resolve().then(() => shell("/")).catch(() => null) : null;
  if (home?.ok && String(home.headers.get("content-type") || "").includes("text/html")) return home;
  await home?.body?.cancel?.();
  return null;
};
const plainPage = (title, body, language) => `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title>${SIGNUP_FORMS_STYLE}</head><body><main>${body}</main></body></html>`;

// /join/<slug>/: the form's own page in the website's look, or null for an address that is not a live form's.
export async function serveJoinPage(request, snapshot, { shell, formCheck = "", language = "en" } = {}) {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  const match = /^\/join\/([a-z0-9-]{1,40})(\/?)$/.exec(url.pathname);
  const form = match && snapshot?.ready ? snapshot.forms.find((entry) => entry.slug === match[1]) : null;
  if (!form) return null;
  if (!match[2]) return new Response(null, { status: 301, headers: { location: `${JOIN_PREFIX}${form.slug}/${url.search}`, "cache-control": "public, max-age=300" } });
  const home = await shellOf(shell);
  const options = { n: 1, formCheck, language, siteName: snapshot.siteName };
  if (!home) {
    const body = `${renderJoinBlock(form, "page", options)}${script()}`;
    return new Response(request.method === "HEAD" ? null : plainPage(form.heading, body, language), { headers: html({ "cache-control": "no-store", "x-robots-tag": "noindex" }) });
  }
  const look = pageButtonClass(await home.clone().text());
  const composed = composeCollectionPage(home, {
    head: `<meta name="robots" content="noindex">${SIGNUP_FORMS_STYLE}`, body: renderJoinBlock(form, "page", { ...options, look }) + script()
  }, { title: form.heading, summary: form.intro || form.promise, origin: url.origin, canonical: `${url.origin}${JOIN_PREFIX}${form.slug}/`, keepMain: true });
  composed.headers.set("x-robots-tag", "noindex");
  return request.method === "HEAD" ? new Response(null, composed) : composed;
}

// /join/confirm/?token=: the platform's confirmation page (src/customer-accounts/sign-ups.js handleSignupConfirm) drawn
// in the website's look. Opening the link shows a button; only the visitor's own press (a POST) confirms, because mail
// scanners open every link in a message. The token is never sent on to another site (no-referrer).
export async function serveJoinConfirm(request, { siteId, platformOrigin, shell, language = "en" } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== JOIN_CONFIRM_PATH && url.pathname !== JOIN_CONFIRM_PATH.slice(0, -1)) return null;
  if (!siteId || !PLATFORM_ORIGINS.includes(platformOrigin)) return null;
  if (url.pathname !== JOIN_CONFIRM_PATH) return new Response(null, { status: 301, headers: { location: `${JOIN_CONFIRM_PATH}${url.search}`, ...privately } });
  if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST", ...privately } });
  const destination = new URL("/api/signups/confirm", platformOrigin);
  const token = String(url.searchParams.get("token") || "").slice(0, 200);
  if (token) destination.searchParams.set("token", token);
  let status = 503, answer = null;
  try {
    const upstream = await fetch(destination, { method: request.method === "POST" ? "POST" : "GET", redirect: "manual",
      headers: { accept: "application/json", "x-ww-site-id": siteId }, signal: AbortSignal.timeout(20000) });
    status = upstream.status;
    answer = await upstream.json().catch(() => null);
  } catch { answer = null; }
  if (!answer || typeof answer.body !== "string" || typeof answer.title !== "string") {
    status = 503;
    answer = { title: "Confirm your email", body: "<h1>Something went wrong</h1><p>Your email could not be confirmed just now. Please open the link again in a few minutes.</p>" };
  }
  const home = await shellOf(shell);
  const look = home ? pageButtonClass(await home.clone().text()) : "";
  // The platform's buttons wear the website's own.
  const body = `<section class="ww-join ww-join-page ww-join-confirm"><div class="ww-join-inner">${look
    ? answer.body.replace(/<button type="submit">/g, `<button type="submit" class="${escape(look)}">`).replace(/<a class="button"/g, `<a class="${escape(look)}"`)
    : answer.body}</div></section>`;
  if (!home) return new Response(request.method === "HEAD" ? null : plainPage(answer.title, body, language), { status, headers: html(privately) });
  const composed = composeCollectionPage(home, { head: `<meta name="robots" content="noindex,nofollow">${SIGNUP_FORMS_STYLE}`, body },
    { title: answer.title, origin: url.origin, canonical: `${url.origin}${JOIN_CONFIRM_PATH}`, keepMain: true });
  const headers = new Headers(composed.headers);
  for (const [key, value] of Object.entries(privately)) headers.set(key, value);
  return new Response(request.method === "HEAD" ? null : composed.body, { status, headers });
}

// The forms' own script: sends a form to /api/join and says what happened, and opens a pop-up when it should.
export const SIGNUP_FORMS_RUNTIME_SOURCE = String.raw`(function () {
  var store = {
    get: function (key) { try { return window.localStorage.getItem(key); } catch (error) { return null; } },
    set: function (key, value) { try { window.localStorage.setItem(key, value); } catch (error) { /* a private window */ } }
  };
  function bind(form) {
    if (form.hasAttribute("data-ww-join-bound")) return;
    form.setAttribute("data-ww-join-bound", "");
    var id = form.getAttribute("data-ww-join-form");
    var status = form.querySelector("[role='status']");
    var button = form.querySelector("button[type='submit']");
    var label = button ? button.textContent : "";
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var fields = form.querySelectorAll("input[required]");
      for (var i = 0; i < fields.length; i += 1) {
        if (!fields[i].value.trim() || !fields[i].checkValidity()) { fields[i].reportValidity(); fields[i].focus(); return; }
      }
      if (button) { button.disabled = true; button.textContent = form.getAttribute("data-ww-sending"); }
      status.textContent = "";
      var payload = new URLSearchParams();
      new FormData(form).forEach(function (value, key) { payload.append(key, String(value)); });
      fetch(form.getAttribute("action") || "/api/join", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: payload.toString()
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(typeof data.error === "string" && data.error.length <= 200 ? data.error : "");
          store.set("ww-join-" + id, "joined");
          var done = document.createElement("p");
          done.className = "ww-join-done";
          done.setAttribute("role", "status");
          done.setAttribute("tabindex", "-1");
          done.textContent = form.getAttribute("data-ww-done");
          form.replaceWith(done);
          done.focus();
        });
      }).catch(function (error) {
        status.textContent = (error && error.message) || form.getAttribute("data-ww-failed");
        var box = form.querySelector(".cf-turnstile[id]");
        if (box && window.turnstile && window.turnstile.reset) window.turnstile.reset("#" + box.id);
        if (button) { button.disabled = false; button.textContent = label; }
      });
    });
  }
  function popup(dialog) {
    var id = dialog.getAttribute("data-ww-join-popup");
    if (typeof dialog.showModal !== "function" || store.get("ww-join-" + id) === "joined") return;
    var closed = Number(store.get("ww-join-closed-" + id) || 0);
    var again = Number(dialog.getAttribute("data-ww-again") || 30);
    if (closed && Date.now() - closed < again * 86400000) return;
    var delay = Math.max(0, Math.min(60, Number(dialog.getAttribute("data-ww-delay") || 5)));
    dialog.addEventListener("close", function () {
      if (store.get("ww-join-" + id) !== "joined") store.set("ww-join-closed-" + id, String(Date.now()));
    });
    var close = dialog.querySelector("[data-ww-join-close]");
    if (close) close.addEventListener("click", function () { dialog.close(); });
    // A press on the dimmed page around it closes it too.
    dialog.addEventListener("click", function (event) { if (event.target === dialog) dialog.close(); });
    setTimeout(function () {
      // Another pop-up (an owner's flyer) is open: not this time.
      if (document.querySelector("dialog[open]")) return;
      dialog.showModal();
    }, delay * 1000);
  }
  function start() {
    Array.prototype.forEach.call(document.querySelectorAll("form[data-ww-join-form]"), bind);
    Array.prototype.forEach.call(document.querySelectorAll("dialog[data-ww-join-popup]"), popup);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
`;

export function signupFormsAsset(request) {
  if (!["GET", "HEAD"].includes(request.method) || new URL(request.url).pathname !== SIGNUP_FORMS_SCRIPT_PATH) return null;
  return new Response(request.method === "HEAD" ? null : SIGNUP_FORMS_RUNTIME_SOURCE, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300, stale-while-revalidate=86400", "x-content-type-options": "nosniff" }
  });
}
