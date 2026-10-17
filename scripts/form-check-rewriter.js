export function withManagedFormCheck(response, env) {
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY
    || !(response.headers.get("content-type") || "").includes("text/html") || !response.ok) return response;
  const state = { hasManagedForm: false, widgets: 0 };
  const transformed = new HTMLRewriter()
    .on("form", {
      element(form) {
        const action = String(form.getAttribute("action") || "").trim().split(/[?#]/)[0];
        if (!["/api/contact", "/api/subscribe"].includes(action)) return;
        state.hasManagedForm = true;
        form.append('<div id="ww-form-check-' + (++state.widgets) + '" class="cf-turnstile" data-sitekey="' + env.TURNSTILE_SITE_KEY
          + '" data-action="' + (action === "/api/contact" ? "contact" : "subscribe") + '"></div>', { html: true });
      }
    })
    .on("[data-ww-checkout-page]", {
      element(checkout) {
        state.hasManagedForm = true;
        checkout.setAttribute("data-ww-turnstile-sitekey", env.TURNSTILE_SITE_KEY);
      }
    })
    .on("body", {
      element(body) {
        body.onEndTag((endTag) => {
          if (state.hasManagedForm) {
            endTag.before('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>', { html: true });
          }
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