// The managed forms' bot check, in the site's own Worker: which provider protects this site, the markup and loader
// its pages carry, and the server-side verification of what a visitor sends.
//
// The provider is read from the Worker's secrets, so changing it never needs a deploy:
//   OWNER_RECAPTCHA_SITE_KEY + OWNER_RECAPTCHA_SECRET_KEY  the owner's own reCAPTCHA key (OWNER_RECAPTCHA_KIND
//                                                          "checkbox" for a v2 tick-box key; otherwise v3 score)
//   RECAPTCHA_SITE_KEY + RECAPTCHA_SECRET_KEY              the platform's reCAPTCHA v3 key, the default
//   TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY              Cloudflare Turnstile, kept as an option
// With none of them the forms keep their honeypot and rate limits only. Docs: docs/form-checks.md.

export const FORM_CHECK_VERSION = 3;
// reCAPTCHA v3 scores run from 0 (a bot) to 1 (a person). Google's own starting point; tune from real submissions.
export const RECAPTCHA_MIN_SCORE = 0.5;
const KEY = /^[A-Za-z0-9_-]{10,100}$/;
const MANAGED_ACTIONS = { "/api/contact": "contact", "/api/subscribe": "subscribe" };

export function formCheckSettings(env = {}) {
  const pair = (site, secret) => (site || secret ? { siteKey: String(site || ""), secret: String(secret || "") } : null);
  const owner = pair(env.OWNER_RECAPTCHA_SITE_KEY, env.OWNER_RECAPTCHA_SECRET_KEY);
  const platform = pair(env.RECAPTCHA_SITE_KEY, env.RECAPTCHA_SECRET_KEY);
  const turnstile = pair(env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY);
  // A reCAPTCHA key is checked for its shape; Turnstile's are taken as they always were (escaped where written).
  const complete = (keys, strict = true) => Boolean(keys?.secret && keys.siteKey && (!strict || KEY.test(keys.siteKey)));
  // A complete key wins over an incomplete one, so a half-saved owner key never takes a working check away.
  if (complete(owner)) return { provider: "recaptcha", owner: true, kind: String(env.OWNER_RECAPTCHA_KIND || "").toLowerCase() === "checkbox" ? "checkbox" : "score", ...owner };
  if (complete(platform)) return { provider: "recaptcha", owner: false, kind: "score", ...platform };
  if (complete(turnstile, false)) return { provider: "turnstile", owner: false, kind: "managed", ...turnstile };
  const partial = owner || platform || turnstile;
  return partial ? { provider: partial === turnstile ? "turnstile" : "recaptcha", incomplete: true } : null;
}

const attr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// Google's terms allow hiding the floating badge only when the form says this instead.
const NOTICE = {
  en: ['This site is protected by reCAPTCHA and the Google ', 'Privacy Policy', ' and ', 'Terms of Service', ' apply.'],
  tr: ['Bu site reCAPTCHA ile korunmaktadır; Google ', 'Gizlilik Politikası', ' ve ', 'Hizmet Şartları', ' geçerlidir.']
};
export function formCheckNotice(language = "en") {
  const words = NOTICE[String(language || "").toLowerCase().slice(0, 2)] || NOTICE.en;
  return `<p class="ww-form-check-notice">${words[0]}<a href="https://policies.google.com/privacy" rel="noopener" target="_blank">${words[1]}</a>`
    + `${words[2]}<a href="https://policies.google.com/terms" rel="noopener" target="_blank">${words[3]}</a>${words[4]}</p>`;
}

// What goes inside one managed form: the field the token travels in (v3), or the box Google draws (v2), and the notice.
export function formCheckFields(settings, action, language = "en") {
  if (!settings || settings.incomplete) return "";
  if (settings.provider === "turnstile") {
    return `<div class="cf-turnstile" data-sitekey="${attr(settings.siteKey)}" data-action="${attr(action)}"></div>`;
  }
  return (settings.kind === "checkbox"
    ? `<div class="ww-form-check-box" data-ww-form-check="${attr(action)}"></div>`
    : `<input type="hidden" name="g-recaptcha-response" value="" data-ww-form-check="${attr(action)}">`)
    + formCheckNotice(language);
}

// Loaded once per page, after the forms. reCAPTCHA's own script is heavy, so it is fetched only when a visitor first
// touches a protected form (or submits one), never on page load. A submit is held until a fresh token is in the form,
// then sent again; each token is used once and cleared, because Google refuses a token it has already answered.
const RECAPTCHA_LOADER = String.raw`(function () {
  if (window.wwFormCheck) return;
  var config = document.currentScript && JSON.parse(document.currentScript.getAttribute("data-ww-form-check-config") || "{}");
  if (!config || !config.key) return;
  var loading = null;
  var boxes = new Map();
  function load() {
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      window.wwFormCheckReady = function () { resolve(window.grecaptcha); };
      var script = document.createElement("script");
      script.src = "https://www.google.com/recaptcha/api.js?onload=wwFormCheckReady&render=" + (config.kind === "checkbox" ? "explicit" : encodeURIComponent(config.key));
      script.async = true;
      var fail = function () { loading = null; failed = true; reject(new Error("unavailable")); };
      script.onerror = fail;
      document.head.appendChild(script);
      setTimeout(function () { if (!window.grecaptcha) fail(); }, 10000);
    });
    return loading;
  }
  // When Google's script cannot load the form still goes, saying so; the server then asks Google itself and lets it
  // through (marked unchecked) only if Google is unreachable from there too.
  var failed = false;
  function unavailable(field) {
    if (field.tagName === "INPUT") { field.value = "unavailable"; return; }
    var input = field.querySelector("input[name='g-recaptcha-response']") || document.createElement("input");
    input.type = "hidden"; input.name = "g-recaptcha-response"; input.value = "unavailable";
    field.appendChild(input);
  }
  function box(container) {
    return load().then(function (g) {
      if (!boxes.has(container)) {
        var waiting = [];
        var id = g.render(container, { sitekey: config.key, callback: function (value) { waiting.splice(0).forEach(function (done) { done(value); }); } });
        boxes.set(container, { id: id, waiting: waiting });
      }
      return boxes.get(container);
    });
  }
  // A token for one action. A v2 box answers once the visitor has ticked it.
  function token(action, container) {
    if (config.kind === "checkbox") {
      if (!container) return Promise.reject(new Error("no box"));
      return box(container).then(function (entry) {
        var value = window.grecaptcha.getResponse(entry.id);
        if (value) { setTimeout(function () { window.grecaptcha.reset(entry.id); }, 0); return value; }
        return new Promise(function (resolve) { entry.waiting.push(resolve); });
      });
    }
    return load().then(function (g) {
      return new Promise(function (resolve, reject) {
        g.ready(function () { g.execute(config.key, { action: action }).then(resolve, reject); });
      });
    });
  }
  window.wwFormCheck = { provider: "recaptcha", kind: config.kind, load: load, token: token };
  function marker(form) { return form && form.querySelector ? form.querySelector("[data-ww-form-check]") : null; }
  document.addEventListener("focusin", function (event) {
    var form = event.target && event.target.closest ? event.target.closest("form") : null;
    var field = marker(form);
    if (!field) return;
    if (config.kind === "checkbox") box(field).catch(function () {});
    else load().catch(function () {});
  }, true);
  // Capturing, so it runs before the form's own submit handlers; a held submit reaches them only with its token.
  document.addEventListener("submit", function (event) {
    var form = event.target;
    var field = marker(form);
    if (!field) return;
    if (config.kind === "checkbox") {
      var entry = boxes.get(field);
      var value = entry && window.grecaptcha ? window.grecaptcha.getResponse(entry.id) : "";
      if (value) { setTimeout(function () { window.grecaptcha.reset(entry.id); }, 0); return; }
      if (failed) { unavailable(field); return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      box(field).then(function () { field.scrollIntoView({ block: "center" }); }, function () {
        unavailable(field);
        setTimeout(function () { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }, 0);
      });
      return;
    }
    if (field.getAttribute("data-ww-ready") === "1") {
      field.removeAttribute("data-ww-ready");
      setTimeout(function () { field.value = ""; }, 0);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (form.hasAttribute("data-ww-form-checking")) return;
    form.setAttribute("data-ww-form-checking", "");
    var submitter = event.submitter && event.submitter.form === form ? event.submitter : null;
    token(field.getAttribute("data-ww-form-check")).then(function (value) { field.value = value; }, function () { unavailable(field); })
      .then(function () {
        form.removeAttribute("data-ww-form-checking");
        field.setAttribute("data-ww-ready", "1");
        // In a task of its own: a submit asked for while the browser is still handling the held one is dropped.
        setTimeout(function () {
          if (form.requestSubmit) form.requestSubmit(submitter || undefined);
          else form.submit();
        }, 0);
      });
  }, true);
})();`;

export function formCheckLoader(settings) {
  if (!settings || settings.incomplete) return "";
  if (settings.provider === "turnstile") return '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
  return '<style>.grecaptcha-badge{visibility:hidden}.ww-form-check-notice{font-size:.8em;opacity:.8;margin:.5em 0 0}'
    + '.ww-form-check-notice a{color:inherit;text-decoration:underline}.ww-form-check-box{margin:.5em 0}</style>'
    + `<script data-ww-form-check-config="${attr(JSON.stringify({ key: settings.siteKey, kind: settings.kind }))}">${RECAPTCHA_LOADER}</script>`;
}

// The sentence a site's own privacy page gains while its forms use a check, unless the page already names it.
const PRIVACY_PATH = /(?:^|\/)(?:privacy|privacy-policy|privacy-notice|gizlilik|gizlilik-politikasi)(?:\.html)?\/?$/i;
const PRIVACY_SENTENCE = {
  recaptcha: {
    en: 'Forms on this website are protected from spam by Google reCAPTCHA. When you use a form, reCAPTCHA collects information about your device and browser and sends it to Google to tell people from automated programs; Google\'s <a href="https://policies.google.com/privacy" rel="noopener">Privacy Policy</a> and <a href="https://policies.google.com/terms" rel="noopener">Terms of Service</a> apply.',
    tr: 'Bu web sitesindeki formlar Google reCAPTCHA ile istenmeyen iletilere karşı korunur. Bir formu kullandığınızda reCAPTCHA, insanları otomatik programlardan ayırt etmek için cihazınız ve tarayıcınız hakkında bilgi toplar ve Google\'a gönderir; Google <a href="https://policies.google.com/privacy" rel="noopener">Gizlilik Politikası</a> ve <a href="https://policies.google.com/terms" rel="noopener">Hizmet Şartları</a> geçerlidir.'
  },
  turnstile: {
    en: 'Forms on this website are protected from spam by Cloudflare Turnstile, which checks information about your browser to tell people from automated programs; <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare\'s Privacy Policy</a> applies.',
    tr: 'Bu web sitesindeki formlar Cloudflare Turnstile ile istenmeyen iletilere karşı korunur; Turnstile, insanları otomatik programlardan ayırt etmek için tarayıcınız hakkındaki bilgileri kontrol eder ve <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare Gizlilik Politikası</a> geçerlidir.'
  }
};
export function privacySentence(settings, language = "en") {
  const words = PRIVACY_SENTENCE[settings?.provider];
  if (!words || settings.incomplete) return "";
  return `<p class="ww-form-check-privacy">${words[String(language || "").toLowerCase().slice(0, 2)] || words.en}</p>`;
}

export function withManagedFormCheck(response, env, request = null) {
  const settings = formCheckSettings(env);
  if (!settings || settings.incomplete
    || !(response.headers.get("content-type") || "").includes("text/html") || !response.ok) return response;
  const state = { hasManagedForm: false, widgets: 0, language: "en", named: false, mains: 0 };
  let privacyPage = false;
  try { privacyPage = Boolean(request?.url) && PRIVACY_PATH.test(new URL(request.url).pathname); } catch { /* not a page address */ }
  const named = new RegExp(settings.provider === "recaptcha" ? "recaptcha" : "turnstile", "i");
  const transformed = new HTMLRewriter()
    .on("html", { element(html) { state.language = html.getAttribute("lang") || "en"; } })
    .on("main", {
      element(main) {
        if (!privacyPage || state.mains++) return;
        main.onEndTag((endTag) => { if (!state.named) endTag.before(privacySentence(settings, state.language), { html: true }); });
      },
      text(chunk) { if (privacyPage && named.test(chunk.text)) state.named = true; }
    })
    .on("form", {
      element(form) {
        const action = String(form.getAttribute("action") || "").trim().split(/[?#]/)[0];
        if (!MANAGED_ACTIONS[action]) return;
        state.hasManagedForm = true;
        const fields = formCheckFields(settings, MANAGED_ACTIONS[action], state.language);
        // The Turnstile box keeps the id older pages' scripts reset it by.
        form.append(settings.provider === "turnstile"
          ? fields.replace('<div class="cf-turnstile"', `<div id="ww-form-check-${++state.widgets}" class="cf-turnstile"`) : fields, { html: true });
      }
    })
    .on("[data-ww-checkout-page]", {
      element(checkout) {
        state.hasManagedForm = true;
        if (settings.provider === "turnstile") {
          checkout.setAttribute("data-ww-turnstile-sitekey", settings.siteKey);
          return;
        }
        checkout.setAttribute("data-ww-recaptcha-sitekey", settings.siteKey);
        checkout.setAttribute("data-ww-recaptcha-kind", settings.kind);
        checkout.after(formCheckNotice(state.language), { html: true });
      }
    })
    .on("body", {
      element(body) {
        body.onEndTag((endTag) => {
          if (state.hasManagedForm) endTag.before(formCheckLoader(settings), { html: true });
        });
      }
    })
    .transform(response);
  const headers = new Headers(transformed.headers);
  headers.set("cache-control", "no-store");
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers
  });
}

// ---------------------------------------------------------------------------
// Server side: one call per protected submission.
// ---------------------------------------------------------------------------

// Takes the token out of a parsed form body (it is not part of the message) and returns it.
export function takeFormCheckToken(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { recaptcha: null, turnstile: null };
  const tokens = { recaptcha: body["g-recaptcha-response"] ?? null, turnstile: body["cf-turnstile-response"] ?? null };
  delete body["g-recaptcha-response"];
  delete body["cf-turnstile-response"];
  return tokens;
}

async function verifyTurnstile(token, secret, request, action, fetchImpl) {
  if (typeof token !== "string" || !token || token.length > 2048) return { ok: false };
  try {
    const form = new URLSearchParams({ secret, response: token });
    const remoteIp = request.headers.get("cf-connecting-ip");
    if (remoteIp) form.set("remoteip", remoteIp);
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form
    });
    const result = await response.json().catch(() => null);
    return { ok: response.ok && result?.success === true
      && String(result?.hostname || "").toLowerCase() === new URL(request.url).hostname.toLowerCase()
      && result?.action === action };
  } catch {
    return { ok: false };
  }
}

// Fails open only when Google cannot answer (or our own secret is wrong, which no visitor can cause): the message
// goes through marked as unchecked, so an outage never loses a visitor's message. A token Google answers as invalid,
// used before, too low a score, for another action or minted on another hostname is refused.
async function verifyRecaptcha(token, settings, request, action, fetchImpl) {
  if (typeof token !== "string" || !token || token.length > 4096) return { ok: false, reason: "missing" };
  let response;
  try {
    const form = new URLSearchParams({ secret: settings.secret, response: token });
    const remoteIp = request.headers.get("cf-connecting-ip");
    if (remoteIp) form.set("remoteip", remoteIp);
    response = await fetchImpl("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    return { ok: true, unverified: true, reason: "unreachable" };
  }
  const result = response.ok ? await response.json().catch(() => null) : null;
  if (!result) return { ok: true, unverified: true, reason: `answered ${response.status}` };
  const errors = Array.isArray(result["error-codes"]) ? result["error-codes"].map(String) : [];
  if (result.success !== true) {
    if (errors.some((code) => /secret/.test(code))) return { ok: true, unverified: true, reason: "secret refused" };
    return { ok: false, reason: errors.join(",") || "refused" };
  }
  if (String(result.hostname || "").toLowerCase() !== new URL(request.url).hostname.toLowerCase()) return { ok: false, reason: "hostname" };
  if (settings.kind === "checkbox") return { ok: true };
  if (result.action !== action) return { ok: false, reason: "action" };
  const score = Number(result.score);
  if (!Number.isFinite(score) || score < RECAPTCHA_MIN_SCORE) return { ok: false, reason: "score", score };
  return { ok: true, score };
}

// { status, message } when the submission is refused; { unverified: true } when it goes through unchecked; null when
// it passed or the site has no check. Each verification is counted (the FORM_CHECKS Analytics Engine dataset), which
// is how the operator digest knows the month's reCAPTCHA assessments against Google's free tier.
export async function verifyFormCheck(tokens, env, request, action, fetchImpl = fetch) {
  const settings = formCheckSettings(env);
  if (!settings) return null;
  if (settings.incomplete) return { status: 503, message: "The form security check is unavailable. Please try again shortly." };
  const outcome = settings.provider === "recaptcha"
    ? await verifyRecaptcha(tokens?.recaptcha, settings, request, action, fetchImpl)
    : await verifyTurnstile(tokens?.turnstile, settings.secret, request, action, fetchImpl);
  try {
    env.FORM_CHECKS?.writeDataPoint?.({
      blobs: [settings.provider, outcome.ok ? (outcome.unverified ? "unverified" : "passed") : "refused", action, settings.owner ? "owner" : "platform"],
      doubles: [1, Number.isFinite(outcome.score) ? outcome.score : -1]
    });
  } catch { /* counting never decides a submission */ }
  if (!outcome.ok) {
    console.log(JSON.stringify({ event: "form_check_refused", provider: settings.provider, action, reason: outcome.reason || "" }));
    return { status: 400, message: "Please complete the security check and try again." };
  }
  if (outcome.unverified) {
    console.error(JSON.stringify({ event: "form_check_unverified", provider: settings.provider, action, reason: outcome.reason }));
    return { unverified: true };
  }
  return null;
}

// What the site's capabilities endpoint says about its check, for the platform's provisioning and the Security tab.
export function formCheckCapabilities(env) {
  const settings = formCheckSettings(env);
  return {
    formCheckVersion: FORM_CHECK_VERSION,
    formCheckProvider: settings && !settings.incomplete ? settings.provider : null,
    formCheckKind: settings && !settings.incomplete ? settings.kind : null,
    formCheckOwnerKey: Boolean(settings?.owner),
    formCheckEnabled: Boolean(settings && !settings.incomplete),
    recaptchaSiteKey: settings?.provider === "recaptcha" && !settings.incomplete ? settings.siteKey : null
  };
}
