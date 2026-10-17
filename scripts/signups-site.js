// Email signups on the website with no page change. When the owner turns signups on and no page carries a signup form,
// the platform publishes site-integrations/<site>/signups.json with form "footer", and the website's own server draws a
// small form just above the site's footer on every page while it is served: an email field, a consent box, the site's
// own button look, posting to the /api/subscribe route every site Worker already answers. Turned off, or switched to
// "none" because a page already has its own form, nothing is drawn.
//
// The form carries data-ww-subscription-ready so the site's own signup behaviour (scripts/subscription-form-runtime.mjs)
// leaves it alone: this module's script, served from the website's own address, handles it in the page's language. A
// page that turns out to hold another signup form keeps that one, and the drawn form takes itself away.

export const SIGNUPS_RENDER_VERSION = 1;
export const SIGNUP_SCRIPT_PATH = "/_ww/signups.js";

const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);

export function parseSignups(text) {
  try {
    const value = typeof text === "string" ? (text ? JSON.parse(text) : null) : text;
    return {
      enabled: value?.enabled === true,
      form: value?.form === "footer" ? "footer" : "none",
      heading: line(value?.heading, 80),
      name: line(value?.name, 80)
    };
  } catch { return { enabled: false, form: "none", heading: "", name: "" }; }
}

const WORDS = {
  en: { heading: "Get our news by email", email: "Email address", consent: (name) => `Yes, email me updates${name ? ` from ${name}` : ""}. I can unsubscribe at any time.`,
    button: "Sign up", sending: "Sending…", needConsent: "Please tick the box to confirm you want these emails.",
    done: "Check your email to confirm your subscription.", failed: "Your request could not be sent. Please try again." },
  tr: { heading: "Haberlerimizi e-postayla alın", email: "E-posta adresi", consent: (name) => `Evet, ${name ? `${name} güncellemelerini` : "güncellemeleri"} e-postayla almak istiyorum. İstediğim zaman abonelikten çıkabilirim.`,
    button: "Abone ol", sending: "Gönderiliyor…", needConsent: "Lütfen bu e-postaları almak istediğinizi onaylamak için kutuyu işaretleyin.",
    done: "Aboneliğinizi onaylamak için e-postanızı kontrol edin.", failed: "İsteğiniz gönderilemedi. Lütfen tekrar deneyin." },
  de: { heading: "Unsere Neuigkeiten per E-Mail", email: "E-Mail-Adresse", consent: (name) => `Ja, schickt mir Neuigkeiten${name ? ` von ${name}` : ""} per E-Mail. Ich kann mich jederzeit abmelden.`,
    button: "Anmelden", sending: "Wird gesendet…", needConsent: "Bitte bestätigen Sie mit dem Häkchen, dass Sie diese E-Mails möchten.",
    done: "Bitte bestätigen Sie Ihr Abonnement über die E-Mail, die wir Ihnen geschickt haben.", failed: "Ihre Anfrage konnte nicht gesendet werden. Bitte versuchen Sie es erneut." },
  es: { heading: "Recibe nuestras novedades por correo", email: "Correo electrónico", consent: (name) => `Sí, quiero recibir novedades${name ? ` de ${name}` : ""} por correo. Puedo darme de baja cuando quiera.`,
    button: "Suscribirme", sending: "Enviando…", needConsent: "Marca la casilla para confirmar que quieres estos correos.",
    done: "Revisa tu correo para confirmar la suscripción.", failed: "No se pudo enviar tu solicitud. Inténtalo de nuevo." },
  fr: { heading: "Recevez nos nouvelles par e-mail", email: "Adresse e-mail", consent: (name) => `Oui, envoyez-moi les nouvelles${name ? ` de ${name}` : ""} par e-mail. Je peux me désinscrire à tout moment.`,
    button: "M'inscrire", sending: "Envoi…", needConsent: "Cochez la case pour confirmer que vous souhaitez ces e-mails.",
    done: "Consultez vos e-mails pour confirmer votre inscription.", failed: "Votre demande n'a pas pu être envoyée. Veuillez réessayer." }
};
export const wordsFor = (language) => WORDS[String(language || "en").slice(0, 2).toLowerCase()] || WORDS.en;

const STYLE = "<style>.ww-signup{padding:clamp(2rem,5vw,3.5rem) 1rem;border-top:1px solid rgba(127,127,127,.2)}"
  + ".ww-signup-inner{max-width:40rem;margin:0 auto}.ww-signup h2{margin:0 0 1rem;font-size:clamp(1.25rem,2.5vw,1.6rem)}"
  + ".ww-signup-row{display:flex;flex-wrap:wrap;gap:.6rem;align-items:stretch}"
  + ".ww-signup input[type=email]{flex:1 1 16rem;min-width:0;font:inherit;padding:.7em .9em;border:1px solid rgba(0,0,0,.3);border-radius:.4em;background:#fff;color:#111}"
  + ".ww-signup button:not([class]){font:inherit;padding:.7em 1.4em;border:0;border-radius:.4em;background:#1f2937;color:#fff;cursor:pointer}"
  + ".ww-signup button{cursor:pointer}.ww-signup-consent{display:flex;gap:.5rem;align-items:flex-start;margin:.8rem 0 0;font-size:.9em}"
  + ".ww-signup-consent input{margin-top:.25em}.ww-signup-status{margin:.6rem 0 0;font-size:.95em}.ww-signup-status:empty{display:none}"
  + ".ww-signup-hidden{position:absolute!important;left:-10000px;width:1px;height:1px;overflow:hidden}</style>";

// The class a call-to-action button in the page's content wears, kept only when it is plain class names, so the drawn
// button looks like the site's. Controls that only look like buttons (menus, sliders, tabs) are not a look to copy.
const NOT_A_LOOK = /toggle|close|menu|nav|hamburger|burger|carousel|slider|slick|swiper|arrow|prev|next|play|tab|accordion|dropdown|search|lightbox/i;
export function buttonClass(value) {
  const raw = String(value || "");
  if (NOT_A_LOOK.test(raw)) return "";
  const tokens = raw.split(/\s+/).filter((token) => /^[a-zA-Z0-9_-]{1,60}$/.test(token)
    && !["active", "current", "selected", "is-active", "is-current", "disabled", "is-disabled"].includes(token));
  return tokens.length && tokens.length <= 6 ? tokens.join(" ") : "";
}

export function renderSignupForm(settings, { language = "en", mainLanguage = true, turnstileSiteKey = "", buttonClass: look = "" } = {}) {
  const words = wordsFor(language);
  const heading = mainLanguage && settings.heading ? settings.heading : words.heading;
  const id = "ww-signup-email";
  const check = turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${escape(turnstileSiteKey)}" data-action="subscribe" id="ww-signup-check"></div>`
      + "<script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" async defer></script>"
    : "";
  return `${STYLE}<section class="ww-signup" data-ww-signup-drawn aria-labelledby="ww-signup-title"><div class="ww-signup-inner">`
    + `<h2 id="ww-signup-title">${escape(heading)}</h2>`
    + `<form method="post" action="/api/subscribe" data-ww-signup-form data-ww-subscription-ready novalidate`
    + ` data-ww-sending="${escape(words.sending)}" data-ww-need-consent="${escape(words.needConsent)}" data-ww-done="${escape(words.done)}" data-ww-failed="${escape(words.failed)}">`
    + `<div class="ww-signup-row"><label class="ww-signup-hidden" for="${id}">${escape(words.email)}</label>`
    + `<input id="${id}" type="email" name="email" autocomplete="email" required placeholder="${escape(words.email)}">`
    + `<button type="submit"${look ? ` class="${escape(look)}"` : ""}>${escape(words.button)}</button></div>`
    + `<label class="ww-signup-hidden" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>`
    + `<label class="ww-signup-consent"><input type="checkbox" name="consent" value="yes" required><span>${escape(words.consent(settings.name))}</span></label>`
    + check
    + `<p class="ww-signup-status" role="status" aria-live="polite"></p></form></div></section>`
    + `<script src="${SIGNUP_SCRIPT_PATH}?v=${SIGNUPS_RENDER_VERSION}" defer data-ww-signup-script></script>`;
}

// Pages where a signup band does not belong: checkout, the cart and the customer's own account.
const SKIP = /^\/(?:checkout|cart|account|orders|_ww|api)(?:\/|$)/;

// The page with the form drawn just above the site's footer - the first <footer> that is not inside the page's own
// content - or at the end of <body> when the site has none. A page whose content already holds a signup form is left
// alone; one whose footer holds one gets the form and the script takes it away again.
export function addSignupForm(response, settings, { language = "en", mainLanguage = true, turnstileSiteKey = "", pathname = "/" } = {}) {
  if (!settings?.enabled || settings.form !== "footer" || SKIP.test(pathname) || typeof HTMLRewriter === "undefined") return response;
  if (!response?.ok || !String(response.headers?.get?.("content-type") || "").includes("text/html")) return response;
  let inside = 0, placed = false, ownForm = false, look = null;
  const form = () => renderSignupForm(settings, { language, mainLanguage, turnstileSiteKey, buttonClass: look || "" });
  return new HTMLRewriter()
    .on("main, article", { element(element) {
      inside += 1;
      element.onEndTag(() => { inside -= 1; });
    } })
    .on("form", { element(element) {
      const action = String(element.getAttribute("action") || "");
      const behaviours = String(element.getAttribute("data-ww-behavior") || "").split(/\s+/);
      if (/^(?:https?:\/\/[^/]+)?\/api\/subscribe(?:[?#]|$)/.test(action) || behaviours.includes("subscription-form")) ownForm = true;
    } })
    .on('a[class*="btn"], button[class*="btn"], a[class*="button"], button[class*="button"]', { element(element) {
      if (look === null && !placed && inside > 0) look = buttonClass(element.getAttribute("class")) || null;
    } })
    .on("footer", { element(element) {
      if (placed || inside > 0) return;
      placed = true;
      if (!ownForm) element.before(form(), { html: true });
    } })
    .on("body", { element(element) {
      element.onEndTag((end) => {
        if (placed) return;
        placed = true;
        if (!ownForm) end.before(form(), { html: true });
      });
    } })
    .transform(response);
}

// The form's own script, served from the website's address so a strict Content-Security-Policy still allows it.
export const SIGNUP_RUNTIME_SOURCE = String.raw`(function () {
  function others(form) {
    return Array.prototype.some.call(document.querySelectorAll("form"), function (candidate) {
      if (candidate === form || candidate.hasAttribute("data-ww-signup-form")) return false;
      var action = candidate.getAttribute("action") || "";
      var declared = (candidate.getAttribute("data-ww-behavior") || "").split(/\s+/).indexOf("subscription-form") >= 0;
      return declared || /^(?:https?:\/\/[^/]+)?\/api\/subscribe(?:[?#]|$)/.test(action);
    });
  }
  function bind(form) {
    if (form.hasAttribute("data-ww-signup-bound")) return;
    form.setAttribute("data-ww-signup-bound", "");
    var section = form.closest("[data-ww-signup-drawn]");
    if (others(form)) { if (section) section.remove(); return; }
    var status = form.querySelector("[role='status']");
    var button = form.querySelector("button[type='submit']");
    var label = button ? button.textContent : "";
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var consent = form.querySelector("[name='consent']");
      if (!consent || !consent.checked) { status.textContent = form.getAttribute("data-ww-need-consent"); consent && consent.focus(); return; }
      var email = form.querySelector("[name='email']");
      if (email && !email.checkValidity()) { email.reportValidity(); return; }
      if (button) { button.disabled = true; button.textContent = form.getAttribute("data-ww-sending"); }
      status.textContent = "";
      var payload = new URLSearchParams();
      new FormData(form).forEach(function (value, key) { payload.append(key, String(value)); });
      fetch(form.getAttribute("action") || "/api/subscribe", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: payload.toString()
      }).then(function (response) {
        if (!response.ok) throw new Error("failed");
        status.textContent = form.getAttribute("data-ww-done");
        form.reset();
      }).catch(function () {
        status.textContent = form.getAttribute("data-ww-failed");
      }).then(function () {
        if (window.turnstile && window.turnstile.reset && form.querySelector("#ww-signup-check")) window.turnstile.reset("#ww-signup-check");
        if (button) { button.disabled = false; button.textContent = label; }
      });
    });
  }
  function start() { Array.prototype.forEach.call(document.querySelectorAll("form[data-ww-signup-form]"), bind); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
`;

export function signupAsset(request) {
  if (!["GET", "HEAD"].includes(request.method) || new URL(request.url).pathname !== SIGNUP_SCRIPT_PATH) return null;
  return new Response(request.method === "HEAD" ? null : SIGNUP_RUNTIME_SOURCE, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300, stale-while-revalidate=86400", "x-content-type-options": "nosniff" }
  });
}
