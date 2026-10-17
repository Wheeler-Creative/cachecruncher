// A pop-up flyer: what the owner designed (picture, words, buttons, colours) and when and where it shows. Shared by
// the owner's flyer workshop, the platform (which checks what is saved) and every website's Worker (which draws it),
// so the preview and the website cannot drift. Owner text is always escaped; links go through cleanTarget.

import { cleanTarget } from "./newsletter-blocks.js";

// "cover": the picture fills the flyer and the words sit over it, on a dark panel that keeps them readable whatever
// the picture is. "image" is the picture alone, for artwork that already carries its own words. "layers" is such
// artwork with its words lifted out (src/flyer-words.js): the picture without them, and the words drawn back over it as
// live text where they were, in a font close to the original, so a word can change without the picture being redrawn.
export const POPUP_LAYOUTS = Object.freeze(["stacked", "side", "cover", "image", "text", "layers"]);
export const MAX_POPUP_LAYERS = 30;
export const LAYER_ALIGNS = Object.freeze(["left", "center", "right"]);
// The kind of lettering a word layer is, and what a browser draws while its font loads.
export const FONT_FALLBACKS = Object.freeze({ "sans-serif": "sans-serif", serif: "serif", display: "sans-serif", handwriting: "cursive" });
// Whose buttons the flyer wears: the website's own ("site", drawn from buttonLook) or the flyer's accent colour.
export const POPUP_BUTTON_LOOKS = Object.freeze(["flyer", "site"]);
export const POPUP_FREQUENCIES = Object.freeze(["once", "visit", "always"]);
export const POPUP_PAGES = Object.freeze(["all", "home", "chosen"]);
export const POPUP_BUTTON_STYLES = Object.freeze(["primary", "secondary"]);
export const MAX_POPUP_BUTTONS = 3;
export const MAX_POPUP_PATHS = 20;

export const POPUP_THEMES = Object.freeze({
  classic: { background: "#ffffff", text: "#1d232b", accent: "#1f5b84" },
  night: { background: "#151b24", text: "#f4f6f9", accent: "#f2b23a" },
  warm: { background: "#fff6e8", text: "#3b2412", accent: "#c4501b" },
  fresh: { background: "#f2faf5", text: "#173226", accent: "#1d7a4b" },
  bold: { background: "#ffd43b", text: "#111111", accent: "#111111" }
});

export const DEFAULT_POPUP = Object.freeze({
  layout: "stacked",
  image: null,
  eyebrow: "",
  heading: "",
  body: "",
  buttons: [],
  dismissLabel: "Not now",
  fineprint: "",
  theme: POPUP_THEMES.classic,
  buttonStyle: "flyer",
  buttonLook: null
});

export const DEFAULT_DISPLAY = Object.freeze({ pages: "all", paths: [], delaySeconds: 2, frequency: "once", round: 1 });

const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const prose = (value, max) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
const bounded = (value, min, max, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.max(min, Math.min(max, Number(value))) : fallback);
const fine = (value) => Math.round(value * 10000) / 10000;
const colour = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(String(value || "").trim()) ? String(value).trim().toLowerCase() : fallback);

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

// A picture on this website (or an https address), never a script or data URL.
export function cleanImageSource(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 2000 || /[\s<>"`\\]/.test(text)) return null;
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  try { return new URL(text).protocol === "https:" ? new URL(text).href : null; } catch { return null; }
}

// WCAG relative luminance and contrast, for the words on the background and the button's own text.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(first, second) {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
// Black or white, whichever reads better on the button colour; one of them always reaches 4.5:1.
export const inkFor = (background) => (contrast(background, "#111111") >= contrast(background, "#ffffff") ? "#111111" : "#ffffff");

export function normalizeTheme(input = {}) {
  const base = POPUP_THEMES.classic;
  const theme = {
    background: colour(input?.background, base.background),
    text: colour(input?.text, base.text),
    accent: colour(input?.accent, base.accent)
  };
  return theme;
}

// How the website draws its own buttons, as measured on the website (src/site-look.js): colours, corners, weight,
// capitals and spacing. Kept only when every part is a value this stylesheet can use, and never unreadable: a
// label that does not stand out from its button is redrawn in black or white, whichever reads.
export function normalizeButtonLook(input) {
  if (!input || typeof input !== "object") return null;
  const background = colour(input.background, "");
  if (!background) return null;
  const given = colour(input.text, "");
  const border = colour(input.border, "");
  const number = (value, min, max, fallback) => (Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback);
  return {
    background,
    text: given && contrast(given, background) >= 4.5 ? given : inkFor(background),
    border: border || background,
    borderWidth: Math.round(number(input.borderWidth, 0, 4, 0)),
    radius: input.radius === "pill" ? "pill" : Math.round(number(input.radius, 0, 40, 6)),
    weight: Math.round(number(input.weight, 300, 900, 600) / 100) * 100,
    transform: input.transform === "uppercase" ? "uppercase" : "none",
    spacing: Math.round(number(input.spacing, 0, 4, 0) * 100) / 100
  };
}

// A font family by its Google Fonts name: letters, digits and spaces only, so it can sit in a stylesheet as it is.
export const fontFamily = (value) => (/^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(String(value ?? "").trim()) ? String(value).trim().replace(/\s+/g, " ") : "");

// One run of words over the picture. x and y place its anchor (left edge, centre or right edge, by align; top of its
// first line) as fractions of the picture; size is the font size as a fraction of the picture's width, so the flyer
// scales as one. spacing is letter spacing in em; stretch narrows or widens the lettering to match the original.
export function normalizeLayer(input) {
  const text = String(input?.text ?? "").replace(/\r\n?/g, "\n").split("\n").map((part) => part.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n").replace(/^\n+|\n+$/g, "").slice(0, 400);
  const font = fontFamily(input?.font);
  if (!text.trim() || !font) return null;
  return {
    text, font,
    fallback: Object.hasOwn(FONT_FALLBACKS, input?.fallback) ? input.fallback : "sans-serif",
    weight: Math.round(bounded(input?.weight, 100, 900, 400) / 100) * 100,
    x: fine(bounded(input?.x, 0, 1, 0)), y: fine(bounded(input?.y, 0, 1, 0)),
    size: fine(bounded(input?.size, 0.005, 0.6, 0.05)),
    lineHeight: fine(bounded(input?.lineHeight, 0.6, 2.5, 1.15)),
    spacing: fine(bounded(input?.spacing, -0.2, 1, 0)),
    stretch: fine(bounded(input?.stretch, 0.6, 1.4, 1)),
    color: colour(input?.color, "#111111"),
    align: LAYER_ALIGNS.includes(input?.align) ? input.align : "left"
  };
}

// A font file the layers use: Google's copy (cdn), and the website's own copy (src) once one is kept, which is what the
// website serves so that nothing is fetched from elsewhere.
export function normalizeFontFace(input) {
  const family = fontFamily(input?.family);
  const cdn = /^https:\/\/fonts\.gstatic\.com\/[A-Za-z0-9/._-]{1,300}$/.test(String(input?.cdn || "")) ? String(input.cdn) : "";
  const src = /^\/media\/files\/[A-Za-z0-9._-]{1,160}\.woff2$/.test(String(input?.src || "")) ? String(input.src) : "";
  const range = /^[Uu+0-9A-Fa-f, ?-]{1,1500}$/.test(String(input?.range || "")) ? String(input.range) : "";
  if (!family || (!cdn && !src)) return null;
  return { family, weight: Math.round(bounded(input?.weight, 100, 900, 400) / 100) * 100, cdn, src, range };
}

const layersOf = (source) => {
  const layers = (Array.isArray(source.layers) ? source.layers : []).map(normalizeLayer).filter(Boolean).slice(0, MAX_POPUP_LAYERS);
  if (!layers.length) return {};
  const width = Math.round(bounded(source.canvas?.width, 1, 20000, 0));
  const height = Math.round(bounded(source.canvas?.height, 1, 20000, 0));
  const original = cleanImageSource(source.original?.src);
  const flat = cleanImageSource(source.flat?.src);
  return {
    layers,
    canvas: width && height ? { width, height } : null,
    fonts: (Array.isArray(source.fonts) ? source.fonts : []).map(normalizeFontFace).filter(Boolean).slice(0, 60),
    original: original ? { src: original, alt: line(source.original?.alt, 300) } : null,
    flat: flat ? { src: flat, key: line(source.flat?.key, 64) } : null
  };
};

// The words on a layered flyer, in reading order, for wherever they have to be read without the picture.
export const layerWords = (design) => (design.layers || []).map((layer) => layer.text.replace(/\n+/g, " ")).join(" · ");
const isLayered = (design) => design.layout === "layers" && Boolean(design.image) && Boolean(design.layers?.length);

// What a website's snapshot holds for a layered flyer. A website still on an older flyer runtime knows no layered words
// and would show the picture without them, so the snapshot's own picture is the flyer as it looks (flattened, or the
// owner's original), and the picture under the words travels beside it for a website that can draw them.
export function publishedDesign(design) {
  if (!isLayered(design)) return design;
  const picture = design.flat ? { src: design.flat.src, alt: layerWords(design).slice(0, 300) } : design.original;
  return picture ? { ...design, layout: "image", image: picture, layered: { image: design.image } } : design;
}
export function restoredDesign(design) {
  const under = cleanImageSource(design?.layered?.image?.src);
  return under && Array.isArray(design.layers) && design.layers.length ? { ...design, layout: "layers", image: { src: under, alt: "" } } : design;
}

export function normalizeButton(input) {
  const label = line(input?.label, 60);
  const href = cleanTarget(input?.href);
  if (!label || !href) return null;
  return { label, href, style: POPUP_BUTTON_STYLES.includes(input?.style) ? input.style : "primary" };
}

// What the owner designed, cleaned. Unknown fields are dropped; anything malformed falls back to the default.
export function normalizePopup(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const src = cleanImageSource(source.image?.src);
  const buttons = (Array.isArray(source.buttons) ? source.buttons : []).map(normalizeButton).filter(Boolean).slice(0, MAX_POPUP_BUTTONS);
  return {
    layout: POPUP_LAYOUTS.includes(source.layout) ? source.layout : DEFAULT_POPUP.layout,
    image: src ? { src, alt: line(source.image?.alt, 300) } : null,
    eyebrow: line(source.eyebrow, 60),
    heading: line(source.heading, 120),
    body: prose(source.body, 1200),
    buttons,
    dismissLabel: line(source.dismissLabel ?? DEFAULT_POPUP.dismissLabel, 40),
    fineprint: line(source.fineprint, 300),
    theme: normalizeTheme(source.theme),
    ...buttonsOf(source),
    // Only a flyer whose words were lifted out carries these; other designs are as they always were.
    ...layersOf(source)
  };
}

// "site" only holds with a look to draw: a flyer saved before the website was measured keeps the flyer's own buttons.
function buttonsOf(source) {
  const look = source.buttonStyle === "site" ? normalizeButtonLook(source.buttonLook) : null;
  return { buttonStyle: look ? "site" : "flyer", buttonLook: look };
}

export function cleanPath(value) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("/") || text.startsWith("//") || text.length > 300 || /[\s<>"`\\?#]/.test(text)) return null;
  return text;
}

export function normalizeDisplay(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const paths = [...new Set((Array.isArray(source.paths) ? source.paths : String(source.paths || "").split(/[\n,]+/))
    .map(cleanPath).filter(Boolean))].slice(0, MAX_POPUP_PATHS);
  const pages = POPUP_PAGES.includes(source.pages) ? source.pages : DEFAULT_DISPLAY.pages;
  const delay = Math.round(Number(source.delaySeconds));
  return {
    pages: pages === "chosen" && !paths.length ? "all" : pages,
    paths: pages === "chosen" ? paths : [],
    delaySeconds: Number.isFinite(delay) ? Math.max(0, Math.min(60, delay)) : DEFAULT_DISPLAY.delaySeconds,
    frequency: POPUP_FREQUENCIES.includes(source.frequency) ? source.frequency : DEFAULT_DISPLAY.frequency,
    round: Math.max(1, Math.min(10_000, Math.floor(Number(source.round) || 1)))
  };
}

// What stops a pop-up from being shown: it must say something, and say it readably.
export function popupProblems(design) {
  const problems = [];
  const words = design.heading || design.body;
  if (!words && !design.image) problems.push("Add a heading, some words or a picture.");
  if (design.image && !design.image.alt && design.layout !== "layers" && (design.layout === "image" || !words)) {
    problems.push("Describe the picture for people who cannot see it: it is the whole message.");
  }
  if (design.layout === "image" && !design.image) problems.push("A picture-only pop-up needs a picture.");
  if (design.layout === "cover" && !design.image) problems.push("A flyer with words over a picture needs a picture.");
  if (design.layout === "layers" && !isLayered(design)) problems.push("This flyer's editable words are missing. Put the original flyer back, or choose another layout.");
  // Over a picture the words are drawn white on the flyer's own dark panel, so the chosen colours are not what is read;
  // editable words keep the colours of the owner's own artwork.
  if (!["cover", "layers"].includes(design.layout) && contrast(design.theme.text, design.theme.background) < 4.5) {
    problems.push("The words are hard to read on that background. Choose a darker or lighter colour.");
  }
  return problems;
}

// The colours as CSS custom properties. The website serves them from its own stylesheet (no inline styles), and the
// workshop sets them on the preview.
export function popupVars(theme, buttonLook = null) {
  const clean = normalizeTheme(theme);
  const look = normalizeButtonLook(buttonLook);
  return {
    "--ww-popup-bg": clean.background,
    "--ww-popup-ink": clean.text,
    "--ww-popup-accent": clean.accent,
    "--ww-popup-accent-ink": inkFor(clean.accent),
    // The website's own button, when the flyer wears it. Left out otherwise, and the stylesheet's fallbacks draw the flyer's.
    ...(look ? {
      "--ww-popup-button-bg": look.background,
      "--ww-popup-button-ink": look.text,
      "--ww-popup-button-border": look.border,
      "--ww-popup-button-border-width": `${look.borderWidth}px`,
      "--ww-popup-button-radius": look.radius === "pill" ? "999px" : `${look.radius}px`,
      "--ww-popup-button-weight": String(look.weight),
      "--ww-popup-button-transform": look.transform,
      "--ww-popup-button-spacing": `${look.spacing}px`
    } : {})
  };
}

// The panel the words sit on when the picture fills the flyer. Its darkness is what guarantees they can be read:
// white on this panel over a pure white picture is the worst case, and coverContrastFloor() says what that comes to.
export const COVER_PANEL = Object.freeze({ red: 8, green: 12, blue: 18, alpha: 0.72 });
export function coverContrastFloor() {
  const mix = (channel) => Math.round(255 * (1 - COVER_PANEL.alpha) + channel * COVER_PANEL.alpha);
  const worst = `#${[COVER_PANEL.red, COVER_PANEL.green, COVER_PANEL.blue].map((channel) => mix(channel).toString(16).padStart(2, "0")).join("")}`;
  return contrast("#ffffff", worst);
}

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "preview";

// Where and how each word of a layered flyer is drawn, and its fonts. A website serves this in the flyer stylesheet
// (no inline styles, so a strict Content-Security-Policy still allows it), with its own copies of the fonts first; the
// workshop puts the same rules in its preview with Google's copies (fonts: "cdn").
export function popupLayerCss(id, popup, { fonts = "site" } = {}) {
  const design = normalizePopup(popup);
  if (!isLayered(design)) return "";
  const scope = `.ww-popup[data-ww-popup="${safeId(id)}"]`;
  const used = new Set(design.layers.map((layer) => layer.font));
  const faces = design.fonts.filter((face) => used.has(face.family)).map((face) => {
    const urls = [fonts === "site" ? face.src : "", face.cdn].filter(Boolean).map((url) => `url("${url}")`).join(",");
    return urls ? `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:swap;src:${urls}${face.range ? `;unicode-range:${face.range}` : ""}}` : "";
  }).filter(Boolean);
  // The flyer is as wide as fits the screen at the picture's own shape, so the words stay where they were drawn.
  const ratio = design.canvas ? design.canvas.width / design.canvas.height : 0.75;
  const layers = design.layers.map((layer, index) => `${scope} .ww-popup-layer[data-ww-layer="${index}"]{left:${fine(layer.x * 100)}%;top:${fine(layer.y * 100)}%;`
    + `font-family:"${layer.font}",${FONT_FALLBACKS[layer.fallback]};font-weight:${layer.weight};font-size:${fine(layer.size * 100)}cqw;line-height:${layer.lineHeight};`
    + `letter-spacing:${layer.spacing}em;color:${layer.color};text-align:${layer.align};transform-origin:${layer.align} top;`
    + `transform:translateX(${{ left: "0", center: "-50%", right: "-100%" }[layer.align]}) scaleX(${layer.stretch})}`);
  // The picture's shape is given before it loads, so the words never sit anywhere else while it does.
  const shape = design.canvas ? [`${scope} .ww-popup-canvas{aspect-ratio:${design.canvas.width} / ${design.canvas.height}}${scope} .ww-popup-canvas img{height:100%}`] : [];
  return [...faces, `${scope}.ww-popup--layers{width:min(520px,calc(100vw - 24px),calc((100dvh - 150px) * ${fine(ratio)}))}`, ...shape, ...layers].join("\n");
}

const absolute = (value, origin) => {
  if (!origin || !value.startsWith("/")) return value;
  try { return new URL(value, origin).href; } catch { return value; }
};

const paragraphs = (text) => text.split(/\n{2,}/).map((part) => `<p>${part.split("\n").map(escapeHtml).join("<br>")}</p>`).join("");

const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

// The pop-up as a <dialog>, closed until the website's script opens it. `id` names it for the visitor's "already
// seen" memory; `origin` makes the website's own addresses absolute when drawn somewhere else (the workshop).
export function renderPopupHtml(popup, { id = "preview", display = DEFAULT_DISPLAY, origin = "", closeLabel = "Close" } = {}) {
  const design = normalizePopup(popup);
  const shown = normalizeDisplay(display);
  const flyerId = safeId(id);
  const titleId = `ww-popup-title-${flyerId}`;
  // Editable words without the words (or the picture) to draw are shown as the picture alone.
  const layered = isLayered(design);
  const layout = design.layout === "layers" && !layered ? "image" : design.layout;
  const hiddenTitle = layout === "image" || !design.heading;
  const title = design.heading || design.image?.alt || design.eyebrow || line(design.body, 80) || "Announcement";
  // Layered words are real text, read in place: the first of them names the flyer, and the picture under them is decoration.
  const image = layered
    ? `<div class="ww-popup-media ww-popup-canvas"><img src="${escapeHtml(absolute(design.image.src, origin))}" alt="" decoding="async">`
      + design.layers.map((layer, index) => `<p class="ww-popup-layer" data-ww-layer="${index}"${index ? "" : ` id="${titleId}"`}>${escapeHtml(layer.text)}</p>`).join("")
      + "</div>"
    : design.image && layout !== "text"
      ? `<div class="ww-popup-media"><img src="${escapeHtml(absolute(design.image.src, origin))}" alt="${hiddenTitle && design.image.alt === title ? "" : escapeHtml(design.image.alt)}" decoding="async"></div>`
      : "";
  const buttons = design.buttons.length
    ? `<div class="ww-popup-actions">${design.buttons.map((button) => {
      const external = /^https?:/i.test(button.href) && !(origin && button.href.startsWith(origin));
      return `<a class="ww-popup-button ww-popup-button--${button.style}" href="${escapeHtml(button.href)}" data-ww-popup-go${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(button.label)}</a>`;
    }).join("")}</div>`
    : "";
  const wordy = layout !== "image" && !layered;
  const body = [
    hiddenTitle && !layered ? `<h2 class="ww-popup-sr" id="${titleId}">${escapeHtml(title)}</h2>` : "",
    wordy && design.eyebrow ? `<p class="ww-popup-eyebrow">${escapeHtml(design.eyebrow)}</p>` : "",
    hiddenTitle ? "" : `<h2 class="ww-popup-title" id="${titleId}">${escapeHtml(design.heading)}</h2>`,
    wordy && design.body ? `<div class="ww-popup-text">${paragraphs(design.body)}</div>` : "",
    buttons,
    design.fineprint ? `<p class="ww-popup-fineprint">${escapeHtml(design.fineprint)}</p>` : "",
    design.dismissLabel ? `<button type="button" class="ww-popup-dismiss" data-ww-popup-close>${escapeHtml(design.dismissLabel)}</button>` : ""
  ].join("");
  return `<dialog class="ww-popup ww-popup--${layout}" data-ww-popup="${flyerId}" data-ww-popup-round="${shown.round}"`
    + ` data-ww-popup-delay="${shown.delaySeconds}" data-ww-popup-frequency="${shown.frequency}" aria-labelledby="${titleId}">`
    + `<div class="ww-popup-card"><button type="button" class="ww-popup-close" data-ww-popup-close aria-label="${escapeHtml(closeLabel)}">${CLOSE_ICON}</button>`
    + `${image}<div class="ww-popup-body">${body}</div></div></dialog>`;
}

// Scoped to .ww-popup so the website's own styles are never touched; fonts are the website's own.
export const POPUP_STYLES = `.ww-popup{--ww-popup-bg:#fff;--ww-popup-ink:#1d232b;--ww-popup-accent:#1f5b84;--ww-popup-accent-ink:#fff;box-sizing:border-box;width:min(520px,calc(100vw - 24px));max-width:none;max-height:calc(100dvh - 24px);margin:auto;padding:0;border:0;background:transparent;color:var(--ww-popup-ink);font:inherit;overflow:visible}
.ww-popup *,.ww-popup *::before,.ww-popup *::after{box-sizing:border-box}
.ww-popup::backdrop{background:rgba(9,13,20,.64)}
.ww-popup--side{width:min(860px,calc(100vw - 24px))}
.ww-popup-card{position:relative;display:grid;max-height:calc(100dvh - 24px);overflow:auto;border-radius:18px;background:var(--ww-popup-bg);color:var(--ww-popup-ink);box-shadow:0 26px 80px rgba(0,0,0,.38);overscroll-behavior:contain}
.ww-popup--side .ww-popup-card{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);align-items:stretch}
.ww-popup-media{min-width:0;background:rgba(0,0,0,.06)}
.ww-popup-media img{display:block;width:100%;height:auto;max-height:min(52vh,460px);object-fit:cover}
.ww-popup--side .ww-popup-media img{height:100%;max-height:none}
.ww-popup--image .ww-popup-media img{max-height:calc(100dvh - 190px);object-fit:contain}
.ww-popup-body{display:grid;gap:12px;align-content:center;min-width:0;padding:30px 28px 18px;text-align:center}
.ww-popup--image .ww-popup-body,.ww-popup--layers .ww-popup-body{padding:16px 20px 10px}
.ww-popup-canvas{position:relative;container-type:inline-size;background:none}
.ww-popup--layers .ww-popup-media img{width:100%;height:auto;max-height:none;object-fit:fill}
.ww-popup-layer{position:absolute;margin:0;white-space:pre;overflow-wrap:normal}
.ww-popup--cover .ww-popup-card{min-height:min(540px,calc(100dvh - 24px));align-content:end;background:rgb(${COVER_PANEL.red},${COVER_PANEL.green},${COVER_PANEL.blue});color:#fff}
.ww-popup--cover .ww-popup-media{position:absolute;inset:0;background:none}
.ww-popup--cover .ww-popup-media img{width:100%;height:100%;max-height:none;object-fit:cover}
.ww-popup--cover .ww-popup-body{position:relative;align-self:end;padding:24px 26px 14px;background:rgba(${COVER_PANEL.red},${COVER_PANEL.green},${COVER_PANEL.blue},${COVER_PANEL.alpha});color:#fff}
.ww-popup--cover .ww-popup-button{box-shadow:0 0 0 1px rgba(255,255,255,.4)}
.ww-popup--cover .ww-popup-button--secondary{color:#fff}
.ww-popup-eyebrow{margin:0;font-size:.8rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
.ww-popup-title{margin:0;color:inherit;font-size:clamp(1.45rem,4.2vw,2.1rem);line-height:1.12;letter-spacing:-.01em;overflow-wrap:anywhere}
.ww-popup-text{font-size:1.02rem;line-height:1.55;overflow-wrap:anywhere}
.ww-popup-text p{margin:0 0 .65em}.ww-popup-text p:last-child{margin-bottom:0}
.ww-popup-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:4px}
.ww-popup-button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 24px;border:var(--ww-popup-button-border-width,2px) solid var(--ww-popup-button-border,var(--ww-popup-accent));border-radius:var(--ww-popup-button-radius,999px);font:inherit;font-weight:var(--ww-popup-button-weight,700);line-height:1.2;letter-spacing:var(--ww-popup-button-spacing,normal);text-transform:var(--ww-popup-button-transform,none);text-decoration:none;text-align:center;overflow-wrap:anywhere}
.ww-popup-button--primary{background:var(--ww-popup-button-bg,var(--ww-popup-accent));color:var(--ww-popup-button-ink,var(--ww-popup-accent-ink))}
.ww-popup-button--secondary{border-width:max(var(--ww-popup-button-border-width,2px),2px);border-color:currentColor;background:transparent;color:var(--ww-popup-ink)}
.ww-popup-button:hover{filter:brightness(1.08)}
.ww-popup-fineprint{margin:0;font-size:.8rem;line-height:1.45;opacity:.85}
.ww-popup-dismiss{justify-self:center;min-height:44px;padding:0 14px;border:0;background:none;color:inherit;font:inherit;font-size:.92rem;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.ww-popup-close{position:absolute;top:10px;right:10px;z-index:2;display:grid;place-items:center;width:42px;height:42px;padding:0;border:0;border-radius:50%;background:rgba(10,14,20,.72);color:#fff;cursor:pointer}
.ww-popup-close svg{display:block}
.ww-popup :focus-visible{outline:3px solid var(--ww-popup-accent);outline-offset:3px}
.ww-popup-close:focus-visible{outline-color:#fff;box-shadow:0 0 0 5px rgba(10,14,20,.8)}
.ww-popup-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:640px){.ww-popup--side .ww-popup-card{grid-template-columns:minmax(0,1fr)}.ww-popup--side .ww-popup-media img{height:auto;max-height:40vh}.ww-popup-body{padding:26px 18px 14px}}
@media (prefers-reduced-motion:no-preference){.ww-popup[open]{animation:ww-popup-in .28s ease-out}.ww-popup[open]::backdrop{animation:ww-popup-fade .28s ease-out}}
@keyframes ww-popup-in{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
@keyframes ww-popup-fade{from{opacity:0}to{opacity:1}}`;

// The visitor's side: open after the delay, unless this visitor already saw it (once per visitor or per visit);
// close on the close buttons, Escape or a click outside, and give focus back.
export const POPUP_RUNTIME_SOURCE = `(function(){
var d=document.querySelector("dialog[data-ww-popup]");
if(!d||typeof d.showModal!=="function")return;
var id=d.getAttribute("data-ww-popup"),round=d.getAttribute("data-ww-popup-round")||"1",freq=d.getAttribute("data-ww-popup-frequency")||"once";
var delay=Math.max(0,Math.min(60,Number(d.getAttribute("data-ww-popup-delay"))||0));
var key="ww-popup:"+id+":"+round,store=null;
try{store=freq==="once"?window.localStorage:freq==="visit"?window.sessionStorage:null;if(store&&store.getItem(key))return;}catch(e){store=null;}
var back=null;
d.addEventListener("click",function(e){
if(e.target===d){d.close();return;}
var c=e.target.closest&&e.target.closest("[data-ww-popup-close]");
if(c){e.preventDefault();d.close();}
});
d.addEventListener("close",function(){if(back&&back.focus&&document.contains(back))back.focus();});
function open(){
if(d.open||document.querySelector("dialog[open]:not([data-ww-popup])"))return;
back=document.activeElement;
try{d.showModal();}catch(e){return;}
try{if(store)store.setItem(key,String(Date.now()));}catch(e){}
}
setTimeout(open,delay*1000);
})();`;
