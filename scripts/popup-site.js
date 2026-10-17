// Pop-up flyers on the website. The platform publishes the owner's published pop-ups to
// site-integrations/<site>/popups.json; this picks the one that should show on a page right now, adds it to the page
// as a closed <dialog>, and serves the small script and stylesheet that open and style it. Everything comes from the
// website's own address, so a strict Content-Security-Policy ('self') still allows it.

import { POPUP_RUNTIME_SOURCE, POPUP_STYLES, normalizeDisplay, normalizePopup, popupLayerCss, popupVars, renderPopupHtml, restoredDesign } from "./popup-render.js";

// 2: words over a full-flyer picture ("cover"), and buttons that can wear the website's own style.
// 3: an owner's flyer with its words as live text over the picture ("layers"), in fonts the website serves itself.
export const POPUPS_RENDER_VERSION = 3;
export const POPUP_SCRIPT_PATH = "/_ww/popups.js";
export const POPUP_STYLE_PATH = "/_ww/popups.css";

const time = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export function parsePopups(text) {
  try {
    const value = JSON.parse(text || "{}");
    const popups = (Array.isArray(value.popups) ? value.popups : []).slice(0, 50).map((entry) => ({
      id: String(entry?.id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64),
      startAt: time(entry?.startAt),
      endAt: time(entry?.endAt),
      updatedAt: String(entry?.updatedAt || ""),
      design: normalizePopup(restoredDesign(entry?.design)),
      display: normalizeDisplay(entry?.display)
    })).filter((entry) => entry.id);
    return { popups };
  } catch { return { popups: [] }; }
}

const trimmed = (path) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export function pageMatches(display, pathname) {
  const path = trimmed(String(pathname || "/"));
  if (display.pages === "home") return path === "/" || /^\/[a-z]{2}(?:-[a-z]{2})?$/i.test(path);
  if (display.pages !== "chosen") return true;
  return display.paths.some((wanted) => (wanted.endsWith("*")
    ? path.startsWith(trimmed(wanted.slice(0, -1))) : trimmed(wanted) === path));
}

// The pop-up that shows on this page now: within its dates, for this page; the one that started last wins.
export function activePopup(index, { pathname = "/", now = Date.now() } = {}) {
  const live = (index?.popups || []).filter((popup) => (popup.startAt === null || popup.startAt <= now)
    && (popup.endAt === null || popup.endAt > now) && pageMatches(popup.display, pathname));
  return live.sort((a, b) => (b.startAt || 0) - (a.startAt || 0) || b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

const stamp = (popup) => encodeURIComponent(`${popup.display.round}-${popup.updatedAt}`.replace(/[^0-9A-Za-z.-]/g, ""));

// The script and the stylesheet, with every live pop-up's colours as custom properties.
export function popupAsset(request, index, { now = Date.now() } = {}) {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const path = new URL(request.url).pathname;
  if (path !== POPUP_SCRIPT_PATH && path !== POPUP_STYLE_PATH) return null;
  const script = path === POPUP_SCRIPT_PATH;
  const colours = (index?.popups || []).filter((popup) => popup.endAt === null || popup.endAt > now).map((popup) => {
    const vars = Object.entries(popupVars(popup.design.theme, popup.design.buttonLook)).map(([name, value]) => `${name}:${value}`).join(";");
    return [`.ww-popup[data-ww-popup="${popup.id}"]{${vars}}`, popupLayerCss(popup.id, popup.design)].filter(Boolean).join("\n");
  }).join("\n");
  return new Response(request.method === "HEAD" ? null : script ? POPUP_RUNTIME_SOURCE : `${POPUP_STYLES}\n${colours}`, {
    headers: {
      "content-type": script ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      "x-content-type-options": "nosniff"
    }
  });
}

const CLOSE_LABELS = { en: "Close", tr: "Kapat", de: "Schließen", fr: "Fermer", es: "Cerrar", it: "Chiudi", nl: "Sluiten", pt: "Fechar" };

// The page with the pop-up added: its stylesheet in <head>, the closed dialog and its script at the end of <body>.
export function addPopup(response, popup) {
  if (!popup || typeof HTMLRewriter === "undefined") return response;
  const version = stamp(popup);
  let added = false;
  let closeLabel = CLOSE_LABELS.en;
  return new HTMLRewriter()
    .on("html", { element(element) {
      closeLabel = CLOSE_LABELS[String(element.getAttribute("lang") || "").toLowerCase().split("-")[0]] || CLOSE_LABELS.en;
    } })
    .on("head", { element(element) { element.append(`<link rel="stylesheet" href="${POPUP_STYLE_PATH}?v=${version}" data-ww-popup-style>`, { html: true }); } })
    .on("body", { element(element) {
      element.onEndTag((end) => {
        if (added) return;
        added = true;
        end.before(`${renderPopupHtml(popup.design, { id: popup.id, display: popup.display, closeLabel })}<script src="${POPUP_SCRIPT_PATH}?v=${POPUPS_RENDER_VERSION}" defer data-ww-popup-script></script>`, { html: true });
      });
    } })
    .transform(response);
}
