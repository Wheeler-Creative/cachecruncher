// Contact-form validation, safe email construction, rate-limit bucketing and log
// redaction for the generated-site contact endpoint described in
// docs/nonprofit-platform-features.md section 4.
//
// Why this exists as a standalone offline library: a contact form is the one
// place where an anonymous stranger's bytes become an outbound email sent from
// our sending domain. Get it wrong and the Worker becomes an open relay (header
// injection adds a Bcc:), a spam cannon (no rate limiting), or a way to
// enumerate which nonprofits we host (a different response per recipient). All
// of that is pure logic, so it is unit-tested here rather than discovered in
// production.
//
// Deliberately out of scope, because both need live services: Turnstile
// verification and the actual send. This module produces the validated fields,
// the header values and the two bodies; the caller performs delivery.
//
// Every rule here fails closed: on anything ambiguous we reject, or we accept the
// request and silently discard the message. Never "sanitise and hope".

import { createHmac } from "node:crypto";

export class ContactFormError extends Error {
  // `message` is the visitor-facing sentence (it is echoed to the browser) and
  // `code` is the stable machine identifier used in logs and tests.
  constructor(code, message, field = null) {
    super(message);
    this.name = "ContactFormError";
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Control-character tables
// ---------------------------------------------------------------------------

// Built from code-point numbers rather than written as escape sequences in a
// regular-expression character class, for two reasons: no control character is
// ever literal in this file, and a range typo cannot silently widen or narrow the
// set the way a mistyped range endpoint can.
const TAB = 0x09;
const LINE_FEED = 0x0a;
const NUL_CHAR = String.fromCharCode(0);

const codeRange = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// Code points that mean "new line" to something in the pipeline even though they
// are not CR or LF:
//   U+0085  C1 NEL, a mandatory line break in unicode line breaking (UAX #14)
//   U+2028  LINE SEPARATOR      - a line break to browsers, and to anything that
//   U+2029  PARAGRAPH SEPARATOR   re-serialises through JavaScript source
const UNICODE_LINE_BREAK_CODES = Object.freeze([0x85, 0x2028, 0x2029]);

// Anything here either ends a header line or truncates a header value somewhere
// downstream:
//   U+000D / U+000A  CR and LF, the RFC 5322 line break. This is the one that
//                    matters: it starts a new header (Bcc:, Content-Type:) or,
//                    doubled, ends the header block and replaces the body.
//   U+0000           NUL, truncates values in C-string based MTAs and loggers
//   U+000B / U+000C  VT and FF, treated as line breaks by some parsers
//   U+0085 / U+2028 / U+2029  as above
// The remaining C0, DEL and C1 code points are rejected as a block: a control
// character has no legitimate place in a person's name or a subject line, and an
// allowlist of "harmless" controls is a list we would have to keep being right
// about. HORIZONTAL TAB is the single exception - it is valid header whitespace
// (RFC 5322 folding uses it) and cannot end a line.
const HEADER_BREAK_CODES = Object.freeze([
  ...codeRange(0x00, 0x1f).filter((code) => code !== TAB),
  ...codeRange(0x7f, 0x9f),
  0x2028,
  0x2029
]);

const HEADER_BREAK_SET = new Set(HEADER_BREAK_CODES);
const UNICODE_LINE_BREAK_SET = new Set(UNICODE_LINE_BREAK_CODES);

// The narrower set applied to *decoded* views of a value, rather than to the
// value itself. The asymmetry is deliberate. A raw control character is never
// legitimate, so the whole C0/DEL/C1 block is refused on sight. An encoded
// sequence, by contrast, is often ordinary text - "Price=10" quoted-printable
// decodes to U+0010 and "50%0ff" percent-decodes to U+000F - so a decoded view
// only condemns the value when it produces something that can actually break a
// header: CR, LF, NUL, VT, FF, or a unicode line break.
//
// DEL and the C1 block stay in this set because a percent-decoded C1 byte means
// one of two things, and neither belongs in a header: an overlong or malformed
// UTF-8 break attempt (%c0%8a is an overlong LF, which lax decoders accept), or a
// UTF-8 continuation byte from a client that percent-encoded its body twice. The
// known false positive is a double-encoded multi-byte character such as %e2%82%ac
// for a euro sign, which no browser produces for this endpoint.
const DECODED_BREAK_SET = new Set([
  0x00, 0x0a, 0x0b, 0x0c, 0x0d,
  ...codeRange(0x7f, 0x9f),
  0x2028,
  0x2029
]);
// Controls with no place in a free-text body. LF survives (it is the whole point
// of a textarea); the unicode line breaks are folded to LF before this applies.
const BODY_STRIP_SET = new Set(HEADER_BREAK_CODES.filter((code) => code !== LINE_FEED && !UNICODE_LINE_BREAK_SET.has(code)));
// HTML text context: keep LF so it can become a <br>, drop the rest.
const HTML_TEXT_STRIP_SET = new Set(HEADER_BREAK_CODES.filter((code) => code !== LINE_FEED));
// HTML attribute context: no whitespace of any kind survives as itself.
const HTML_ATTR_SPACE_SET = new Set([...HEADER_BREAK_CODES, TAB, LINE_FEED]);

function containsCode(text, codes) {
  for (const character of String(text)) {
    if (codes.has(character.codePointAt(0))) return true;
  }
  return false;
}

function replaceCodes(text, codes, replacement) {
  let out = "";
  for (const character of String(text)) {
    out += codes.has(character.codePointAt(0)) ? replacement : character;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Field allowlist, types and limits
// ---------------------------------------------------------------------------

// The complete set of accepted fields. `headerBound` marks values that can reach
// an RFC 5322 header (the Reply-To display name, the Subject) and therefore get
// the strict reject-on-sight treatment rather than the lenient body treatment.
export const CONTACT_FIELDS = Object.freeze({
  name: Object.freeze({ label: "your name", required: true, maxLength: 100, headerBound: true }),
  last_name: Object.freeze({ label: "your last name", required: false, maxLength: 100, headerBound: true }),
  // 254 is the longest address that fits an SMTP path: RFC 5321 section 4.5.3.1.3
  // caps the reverse/forward path at 256 octets including the angle brackets.
  email: Object.freeze({ label: "your email address", required: true, maxLength: 254, headerBound: true }),
  subject: Object.freeze({ label: "the subject", required: false, maxLength: 150, headerBound: true }),
  phone: Object.freeze({ label: "your phone number", required: false, maxLength: 40, headerBound: false }),
  // These are explicit, opt-in fields rather than an unbounded "extra" object.
  // A migrated form can retain its real questions without turning the contact
  // endpoint into a general-purpose payload sink or silently dropping answers.
  interest_volunteer: Object.freeze({ label: "Volunteer opportunities", required: false, maxLength: 3, headerBound: false }),
  interest_sponsorship: Object.freeze({ label: "Sponsorship opportunities", required: false, maxLength: 3, headerBound: false }),
  interest_support_groups: Object.freeze({ label: "Support groups", required: false, maxLength: 3, headerBound: false }),
  interest_donation: Object.freeze({ label: "Make a donation", required: false, maxLength: 3, headerBound: false }),
  interest_event_participation: Object.freeze({ label: "Event participation", required: false, maxLength: 3, headerBound: false }),
  interest_mental_health: Object.freeze({ label: "Mental health resources", required: false, maxLength: 3, headerBound: false }),
  interest_media_press: Object.freeze({ label: "Media and press inquiries", required: false, maxLength: 3, headerBound: false }),
  interest_speaking: Object.freeze({ label: "Speaking engagements", required: false, maxLength: 3, headerBound: false }),
  interest_survivor_story: Object.freeze({ label: "Survivor story submission", required: false, maxLength: 3, headerBound: false }),
  interest_advocacy: Object.freeze({ label: "Advocacy", required: false, maxLength: 3, headerBound: false }),
  interest_bullying_resources: Object.freeze({ label: "Bullying support resources", required: false, maxLength: 3, headerBound: false }),
  interest_partnership: Object.freeze({ label: "Community partnerships", required: false, maxLength: 3, headerBound: false }),
  interest_collaboration: Object.freeze({ label: "Collaboration", required: false, maxLength: 3, headerBound: false }),
  interest_general_questions: Object.freeze({ label: "General questions", required: false, maxLength: 3, headerBound: false }),
  other_interest: Object.freeze({ label: "another area of interest", required: false, maxLength: 200, headerBound: false }),
  address_line_1: Object.freeze({ label: "street address", required: false, maxLength: 160, headerBound: false }),
  address_line_2: Object.freeze({ label: "street address line 2", required: false, maxLength: 160, headerBound: false }),
  address_city: Object.freeze({ label: "city", required: false, maxLength: 100, headerBound: false }),
  address_region: Object.freeze({ label: "state or province", required: false, maxLength: 100, headerBound: false }),
  address_postal: Object.freeze({ label: "postal or ZIP code", required: false, maxLength: 32, headerBound: false }),
  message: Object.freeze({ label: "your message", required: true, maxLength: 5000, headerBound: false })
});

// Hidden input that a human never sees and never fills. Named like a plausible
// autofill target, because the bots we care about fill every input they can find
// in the DOM. It must be hidden with CSS (off-screen or zero-opacity) plus
// aria-hidden, NOT with type="hidden": form-filling bots skip type="hidden" and
// happily fill a CSS-hidden text input.
export const HONEYPOT_FIELD = "website_url";

// Total request-body cap. Small on purpose: the largest legitimate submission is
// roughly the sum of the per-field limits (~5.5 KB of text), so 16 KB leaves
// generous headroom for JSON overhead and multi-byte characters while making the
// endpoint useless for uploading anything. Checked before any per-field work, so
// a huge body cannot drive CPU cost.
export const MAX_PAYLOAD_BYTES = 16 * 1024;

// Conservative phone charset. The hyphen is last so it stays literal instead of
// forming a range. Anything else (letters, CR/LF, unicode digits that some
// renderers fold to ASCII) is rejected rather than stripped.
const PHONE_PATTERN = /^[0-9+(). x-]+$/i;

// User-facing limits are counted in code points, not UTF-16 units, so a message
// of emoji is not silently worth half as many characters as a message of Latin
// text. The payload cap is counted in UTF-8 bytes, because that is what actually
// consumes bandwidth and storage.
const codePointLength = (value) => [...value].length;
const utf8Length = (value) => Buffer.byteLength(value, "utf8");

// ---------------------------------------------------------------------------
// 5. Header-injection detection (the critical control)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  newline: "\n",
  linefeed: "\n",
  lf: "\n",
  cr: "\r",
  tab: "\t",
  // "amp" is here so a double-encoded reference (&amp;#13;) collapses to &#13; on
  // one pass and to CR on the next.
  amp: "&",
  nel: String.fromCharCode(0x85),
  nul: NUL_CHAR
};

// Percent-decode treating each %XX as a raw byte and the result as UTF-8. Catches
// UTF-8 percent-encoded unicode breaks such as %e2%80%a8 (U+2028).
function percentDecodeUtf8(value) {
  if (!value.includes("%")) return null;
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    const hex = value.slice(index + 1, index + 3);
    if (value[index] === "%" && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(...Buffer.from(value[index], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

// Percent-decode treating each %XX as a code point. Catches overlong or malformed
// UTF-8 such as %c0%8a (an overlong encoding of LF): the strict UTF-8 decoder
// above turns that into U+FFFD, but this loose view still exposes U+008A, which
// is a C1 control and therefore rejected.
function percentDecodeLatin1(value) {
  if (!value.includes("%")) return null;
  return value.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// HTML numeric and named references, for a value that round-trips through an HTML
// template or a rich-text editor on its way to the header.
function decodeEntities(value) {
  if (!value.includes("&")) return null;
  return value.replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});|&([a-z]{2,8});/gi, (match, hex, dec, name) => {
    if (hex) return codePointOrEmpty(parseInt(hex, 16));
    if (dec) return codePointOrEmpty(parseInt(dec, 10));
    const known = NAMED_ENTITIES[String(name).toLowerCase()];
    return known === undefined ? match : known;
  });
}

// Backslash escapes, for a value interpolated into a JSON template, a YAML
// document, a shell argument or a logger format string that unescapes before the
// header is written.
function decodeBackslash(value) {
  if (!value.includes("\\")) return null;
  return value.replace(/\\(?:x([0-9a-f]{2})|u\{?([0-9a-f]{1,6})\}?|([0-7]{1,3})|(r|n|t|0))/gi, (match, hex, uni, octal, short) => {
    if (hex) return codePointOrEmpty(parseInt(hex, 16));
    if (uni) return codePointOrEmpty(parseInt(uni, 16));
    if (octal) return codePointOrEmpty(parseInt(octal, 8));
    return { r: "\r", n: "\n", t: "\t", 0: NUL_CHAR }[String(short).toLowerCase()] ?? match;
  });
}

// Quoted-printable, which is how a break is smuggled inside an RFC 2047 "Q"
// encoded-word: =?UTF-8?Q?a=0D=0ABcc:_x?=
function decodeQuotedPrintable(value) {
  if (!value.includes("=")) return null;
  return value.replace(/=([0-9a-f]{2})/gi, (_, hex) => codePointOrEmpty(parseInt(hex, 16)));
}

function codePointOrEmpty(code) {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

const DECODERS = [percentDecodeUtf8, percentDecodeLatin1, decodeEntities, decodeBackslash, decodeQuotedPrintable];

// Every form a value could take after a downstream layer decodes it, explored to
// a depth of four so double and triple encoding (%250d -> %0d -> CR) and mixed
// encoding (&#37;0d -> %0d -> CR) are covered. We inspect all of them rather than
// decoding once and using the result, because we do not know which layer decodes:
// the property we want is that no reachable form contains a line break.
export function decodedHeaderVariants(value) {
  const seen = new Set();
  let frontier = [String(value ?? "")];
  const all = [];
  for (let round = 0; round < 4 && frontier.length; round += 1) {
    const next = [];
    for (const item of frontier) {
      if (seen.has(item)) continue;
      seen.add(item);
      all.push(item);
      for (const decode of DECODERS) {
        let decoded = null;
        try {
          decoded = decode(item);
        } catch {
          // A malformed escape must never crash validation. An undecodable form
          // is simply not explored; the raw form is still checked.
          decoded = null;
        }
        if (decoded && decoded !== item && !seen.has(decoded)) next.push(decoded);
      }
    }
    frontier = next;
  }
  return all;
}

export function hasHeaderBreak(value) {
  const text = String(value ?? "");
  // The value as submitted: the whole control block is refused.
  if (containsCode(text, HEADER_BREAK_SET)) return true;
  // Everything it could decode to: only genuine break characters condemn it.
  return decodedHeaderVariants(text).slice(1).some((variant) => containsCode(variant, DECODED_BREAK_SET));
}

// Primary control: reject. We do not clean a header-bound value and carry on,
// because a value containing an encoded CRLF is not a typo - it is an attempt to
// add a Bcc: or replace the body - and silently repairing it hides the attack
// from the logs.
//
// The cost of rejecting the encoded forms as well as the raw ones is the odd
// false positive: a subject of "50%0ff" or a name containing a literal "\n" is
// refused. Neither has a plausible reason to appear in a nonprofit's contact
// form, the visitor gets a clear message and can retype, and the alternative is
// depending on no downstream layer ever unescaping.
export function assertHeaderSafe(value, field = null) {
  const text = String(value ?? "");
  if (!hasHeaderBreak(text)) return text;
  const label = (field && CONTACT_FIELDS[field]?.label) || "that value";
  throw new ContactFormError("header_injection", `Remove line breaks and control characters from ${label}.`, field);
}

// Defence in depth, applied immediately before a value is written into a header
// even though it has already been asserted safe. If a future caller ever skips
// validation, or a new decoder form turns up, the header still cannot be split.
export function sanitizeHeaderValue(value) {
  let text = String(value ?? "");
  if (hasHeaderBreak(text)) {
    // Some decoded view of this value contains a break, so neutralise the
    // encodings that produce it in the literal value too, not just the raw
    // characters.
    text = text
      .replace(/%(25)*[0-9a-f]{2}/gi, " ")
      .replace(/&#x?[0-9a-f]{1,7};/gi, " ")
      .replace(/&[a-z]{2,8};/gi, " ")
      .replace(/\\(x[0-9a-f]{2}|u\{?[0-9a-f]{1,6}\}?|[0-7]{1,3}|[rnt0])/gi, " ")
      .replace(/=[0-9a-f]{2}/gi, " ");
  }
  return replaceCodes(text, HEADER_BREAK_SET, " ")
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// 5b. RFC 2047 encoded words for non-ASCII header text
// ---------------------------------------------------------------------------

// Non-ASCII subjects and display names are supported rather than rejected: these
// are nonprofits with Spanish- and Vietnamese-speaking communities, and dropping
// someone's accents - or their whole subject - is a real cost for no security
// gain, because the encoding below is provably break-free.
//
// "B" (base64) rather than "Q" (quoted-printable) encoding, always, even where Q
// would be shorter and more readable. Q passes most ASCII through literally and
// needs correct escaping of "=", "?" and "_", so a Q encoder is one bug away from
// emitting a raw break. The base64 alphabet is [A-Za-z0-9+/=] and cannot contain
// CR, LF or any control character at all: the encoding itself is the guarantee.
//
// RFC 2047 section 2 caps an encoded-word at 75 characters, and section 5
// requires each word to be independently decodable, so a multi-byte character may
// not be split across two words. We chunk on code-point boundaries.
export const MAX_ENCODED_HEADER = 900;

const ENCODED_WORD_OVERHEAD = "=?UTF-8?B??=".length;
// Whole base64 quantums only, so a word never exceeds 75 characters.
const MAX_WORD_BYTES = Math.floor((75 - ENCODED_WORD_OVERHEAD) / 4) * 3;

const isAsciiPrintable = (value) => !/[^ -~]/.test(value);

export function encodeHeaderWord(value) {
  const text = sanitizeHeaderValue(value);
  if (!text) return "";
  if (isAsciiPrintable(text)) return text;

  const words = [];
  let chunk = [];
  let chunkBytes = 0;
  for (const character of text) {
    const size = utf8Length(character);
    if (chunkBytes + size > MAX_WORD_BYTES && chunk.length) {
      words.push(chunk.join(""));
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(character);
    chunkBytes += size;
  }
  if (chunk.length) words.push(chunk.join(""));

  const encoded = words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`);
  // Truncate whole encoded-words, never mid-word: a partial word decodes to
  // garbage, or the whole header is dropped by some clients. RFC 5322 section
  // 2.1.1 caps a line at 998 octets.
  while (encoded.length > 1 && encoded.join(" ").length > MAX_ENCODED_HEADER) encoded.pop();
  return encoded.join(" ");
}

// ---------------------------------------------------------------------------
// 2. Email normalisation
// ---------------------------------------------------------------------------

// atext (RFC 5322 section 3.2.3) arranged as a dot-atom: atoms joined by single
// dots, with no leading, trailing or doubled dot. The hyphen is last in the class
// so it stays literal. Quoted local parts ("a b"@example.com) are legal per RFC
// 5321 but rejected here: they can carry spaces and quotes, they are vanishingly
// rare in real submissions, and every one we accept is a value we then have to
// quote correctly on the way into a header.
const LOCAL_ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_PATTERN = new RegExp(`^${LOCAL_ATOM}(?:\\.${LOCAL_ATOM})*$`);
const LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// An all-alphabetic TLD, or a punycode A-label (xn--p1ai) so that the ASCII
// spelling of an internationalised domain still works - see the IDN note below.
// This deliberately rejects address literals and bare IPs (a@1.2.3.4,
// a@[10.0.0.1]): legal per RFC 5321 section 4.1.3, but a contact form never
// legitimately receives one and they are a classic way to aim mail at an
// arbitrary host.
const TLD_PATTERN = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{2,59})$/;

export function normalizeEmail(value, field = "email") {
  if (typeof value !== "string") {
    throw new ContactFormError("email_type", "Enter a valid email address.", field);
  }
  const raw = value.trim();
  if (!raw) throw new ContactFormError("email_missing", "Enter your email address.", field);

  // Injection check first, on the untouched value: a break here would reach the
  // Reply-To header directly.
  assertHeaderSafe(raw, field);

  if (/\s/.test(raw)) {
    throw new ContactFormError("email_whitespace", "Enter one email address with no spaces.", field);
  }
  // Multiple addresses. RFC 5322 separates addresses with "," and closes a group
  // with ";"; either turns a single Reply-To into a list, which is how a contact
  // form becomes a way to mail strangers.
  if (/[,;]/.test(raw)) {
    throw new ContactFormError("email_multiple", "Enter only one email address.", field);
  }
  // Display-name and comment forms: "A" <a@b.co>, A <a@b.co>, a@b.co (note),
  // group syntax, and the obsolete source route <@relay:a@b.co>. Rejected as a
  // family, because the point of every one of them is that the address the human
  // reads is not the address the MTA uses.
  if (/["<>()\[\]\\:]/.test(raw)) {
    throw new ContactFormError("email_display_name", "Enter just the email address, with no name or brackets.", field);
  }
  // Non-ASCII: rejected. See the IDN note below.
  if (!isAsciiPrintable(raw)) {
    throw new ContactFormError("email_non_ascii", "Enter an email address using unaccented Latin characters.", field);
  }

  const at = raw.indexOf("@");
  if (at < 1 || at !== raw.lastIndexOf("@") || at === raw.length - 1) {
    throw new ContactFormError("email_structure", "Enter a valid email address.", field);
  }

  const local = raw.slice(0, at);
  // A single trailing root dot (a@example.com.) is a legal FQDN, but left alone
  // it is a second spelling of one address and therefore a second rate-limit
  // bucket. Canonicalise it away; any other trailing dot fails the label check.
  //
  // The domain is case-insensitive (RFC 5321 section 2.4), so it is lowercased
  // here, before validation, giving one canonical spelling to check and to
  // return. The local part is deliberately left alone - see below.
  //
  // The fold is an explicit A-Z map and deliberately not String#toLowerCase:
  // unicode case folding maps KELVIN SIGN (U+212A) to "k" and LATIN CAPITAL
  // LETTER I WITH DOT ABOVE (U+0130) to two code points, so a toLowerCase-based
  // normaliser can turn a non-ASCII domain into an ASCII-looking one after an
  // ASCII check has already passed. Here the ASCII check runs first and this fold
  // cannot introduce anything, so neither ordering is exploitable.
  const domain = raw
    .slice(at + 1)
    .replace(/\.$/, "")
    .replace(/[A-Z]/g, (character) => character.toLowerCase());

  // RFC 5321 sections 4.5.3.1.1 and 4.5.3.1.2.
  if (codePointLength(local) > 64) throw new ContactFormError("email_local_length", "That email address is too long.", field);
  if (domain.length > 255) throw new ContactFormError("email_domain_length", "That email address is too long.", field);
  if (raw.length > CONTACT_FIELDS.email.maxLength) {
    throw new ContactFormError("email_length", "That email address is too long.", field);
  }
  if (!LOCAL_PATTERN.test(local)) throw new ContactFormError("email_local", "Enter a valid email address.", field);

  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL_PATTERN.test(label)) || !TLD_PATTERN.test(labels.at(-1))) {
    throw new ContactFormError("email_domain", "Enter a valid email address.", field);
  }

  // The local part keeps the case it was typed in: RFC 5321 section 2.4 reserves
  // its interpretation to the receiving host and tells relays not to alter it. In
  // practice almost every provider folds case, but "almost" is not a licence to
  // rewrite a stranger's address, and this value is handed to the MTA as Reply-To.
  // Case folding for rate-limit bucketing happens separately, inside the HMAC,
  // where it cannot affect delivery.
  return `${local}@${domain}`;
}

// IDN and unicode domains: rejected above, deliberately, with a clear message
// rather than a silent conversion.
//
// Node can convert with url.domainToASCII, but using it here would be wrong in
// three ways. (1) Its result depends on how Node was built: a full-ICU and a
// small-ICU runtime can disagree, so the same address would be delivered to
// different domains on different hosts - and the Worker runtime is a third
// implementation again. (2) It performs no confusable or mixed-script check, so
// homograph domains convert happily and we would be addressing a domain the
// visitor never typed. (3) A silent rewrite is unauditable: the visitor sees
// their address accepted with no way to know we changed it. Failing closed still
// leaves international visitors a working path, because the ASCII A-label
// spelling of their domain (user@xn--80ak6aa92e.xn--p1ai) passes validation
// unchanged - we accept punycode, we just refuse to compute it. Non-ASCII local
// parts additionally require SMTPUTF8 (RFC 6531) end to end, which we cannot
// assume of the recipient's mail host.

// ---------------------------------------------------------------------------
// 1b. Submission validation
// ---------------------------------------------------------------------------

// Collapse runs of blank lines without a regex, so no escape sequence is needed
// and the rule stays obvious.
function collapseBlankLines(text) {
  const kept = [];
  let blanks = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      blanks += 1;
      if (blanks > 2) continue;
    } else {
      blanks = 0;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// Free-text body treatment: fold every line-break spelling to LF, drop the
// remaining controls, and cap runs of blank lines. Body text is normalised rather
// than rejected because a message legitimately contains newlines - the anti-
// spoofing work for bodies happens at render time, in buildPlainTextEmail.
function normalizeBodyText(value) {
  const folded = replaceCodes(String(value).replace(/\r\n?/g, "\n"), UNICODE_LINE_BREAK_SET, "\n");
  return collapseBlankLines(replaceCodes(folded, BODY_STRIP_SET, "")).trim();
}

function payloadByteLength(body, rawBytes) {
  if (Number.isFinite(rawBytes)) return Math.max(0, Math.trunc(rawBytes));
  try {
    return utf8Length(JSON.stringify(body) ?? "");
  } catch {
    // Circular, a BigInt, or a hostile toJSON. Unmeasurable means unacceptable.
    throw new ContactFormError("payload_unreadable", "We could not read that submission. Please try again.", null);
  }
}

// Validates a decoded request body against the allowlist. Throws ContactFormError
// on anything it does not like, and returns the normalised fields plus whether
// the honeypot was filled. It deliberately does NOT act on the honeypot - see
// evaluateSubmission for why the ordering matters.
export function validateSubmission(body, { rawBytes } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ContactFormError("invalid_payload", "We could not read that submission. Please try again.", null);
  }

  // Size first: cheapest check, and it bounds the cost of everything below.
  const byteLength = payloadByteLength(body, rawBytes);
  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new ContactFormError("payload_too_large", "That submission is too large. Please shorten your message.", null);
  }

  // Unknown fields are REJECTED, not dropped. Dropping is the friendlier
  // behaviour and the wrong one here:
  //  - Mass assignment. The day someone adds support for a "replyTo", "cc",
  //    "template" or "recipient" field, every previously ignored key in every
  //    bot's stored payload becomes live. Rejecting makes new fields opt-in.
  //  - It removes an oracle. With silent dropping an attacker learns the accepted
  //    field set by watching which keys change behaviour; with rejection every
  //    probe gets the same refusal.
  //  - It catches our own drift. A form that starts posting a renamed field fails
  //    loudly at deploy time instead of quietly discarding what a visitor typed.
  // The cost is a 400 for a browser extension that appends a field, which is
  // rare, recoverable and visible - unlike a silently lost message.
  // Object.keys covers own enumerable properties only, which is also what makes a
  // JSON "__proto__" key land here as an unknown field rather than anywhere near
  // a prototype.
  for (const key of Object.keys(body)) {
    if (key !== HONEYPOT_FIELD && !Object.hasOwn(CONTACT_FIELDS, key)) {
      throw new ContactFormError("unknown_field", "This form sent unexpected data. Reload the page and try again.", key);
    }
  }

  const fields = {};
  for (const [name, rule] of Object.entries(CONTACT_FIELDS)) {
    const value = Object.hasOwn(body, name) ? body[name] : undefined;

    // Type smuggling. An array or object where a string belongs is never a
    // browser doing its job: it is repeated form keys or a hand-built JSON body.
    // Coercing is what makes it dangerous - String(["a@x.co", "b@y.co"]) is
    // "a@x.co,b@y.co", a two-recipient Reply-To, and String({}) is
    // "[object Object]". Numbers, booleans and null are refused for the same
    // reason: if the client cannot send a string, it is not our form.
    if (value !== undefined && typeof value !== "string") {
      throw new ContactFormError("field_type", `Enter ${rule.label} as text.`, name);
    }

    const raw = value === undefined ? "" : value;
    const normalized = rule.headerBound ? raw.trim() : normalizeBodyText(raw);

    if (!normalized) {
      if (rule.required) throw new ContactFormError("missing_field", `Enter ${rule.label}.`, name);
      fields[name] = "";
      continue;
    }
    if (codePointLength(normalized) > rule.maxLength) {
      throw new ContactFormError("field_too_long", `Shorten ${rule.label} to ${rule.maxLength} characters or fewer.`, name);
    }
    if (rule.headerBound) assertHeaderSafe(normalized, name);
    fields[name] = normalized;
  }

  if (fields.phone && !PHONE_PATTERN.test(fields.phone)) {
    throw new ContactFormError("field_pattern", "Enter your phone number using digits only.", "phone");
  }
  fields.email = normalizeEmail(fields.email, "email");

  return { fields, honeypotTripped: honeypotTripped(body), byteLength };
}

// ---------------------------------------------------------------------------
// 3. Honeypot
// ---------------------------------------------------------------------------

// A non-string honeypot value counts as tripped: only a script sends an array
// where an empty text input belongs. Whitespace-only counts as empty, because an
// over-eager autofiller or a stray keystroke should not cost a human their
// message.
export function honeypotTripped(body) {
  if (!body || typeof body !== "object") return true;
  if (!Object.hasOwn(body, HONEYPOT_FIELD)) return false;
  const value = body[HONEYPOT_FIELD];
  if (typeof value !== "string") return true;
  return value.trim() !== "";
}

// ---------------------------------------------------------------------------
// 8. One response shape for every outcome
// ---------------------------------------------------------------------------

// A single frozen object, returned by identity for every accepted submission and
// for every silently discarded one. Note what is NOT in it: no submission id, no
// timestamp, no recipient, no delivery status, no duration, no counter. Any of
// those would differ between a real send and a discard and hand back the oracle
// we are trying to remove. Frozen so a caller cannot decorate one copy and not
// the other.
//
// Response *timing* is the caller's remaining job: a honeypot discard does no
// provider call, so if the caller awaits delivery before responding, the two
// paths become distinguishable by a stopwatch even though the bodies match.
// Deliver asynchronously (ctx.waitUntil or a queue) and respond immediately.
export const ACCEPTED_RESPONSE = Object.freeze({
  ok: true,
  message: "Thanks - your message has been received. A member of our team will follow up with you.",
  field: null
});

// Rejections share the shape (same keys, same order) and are computed purely from
// the submitted payload: they never consult the recipient, the site or the
// honeypot, so they cannot be used to probe any of them. What they do reveal is
// whether the visitor's own input was well-formed, which the visitor needs in
// order to fix it.
function rejectionResponse(error) {
  return {
    ok: false,
    message: error.message,
    // Only ever an allowlisted field name. An unknown-field rejection reports
    // null rather than echoing the attacker's key back into the response body,
    // so the endpoint cannot be used as a reflection gadget.
    field: error.field && Object.hasOwn(CONTACT_FIELDS, error.field) ? error.field : null
  };
}

// ---------------------------------------------------------------------------
// 4. Safe email construction
// ---------------------------------------------------------------------------

const TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const ATTR_ESCAPES = { ...TEXT_ESCAPES, "`": "&#96;", "=": "&#61;" };

// Text context. Quotes are escaped as well, even though they are harmless between
// tags, so a value that a later edit moves into an attribute is still inert.
export function escapeHtmlText(value) {
  return replaceCodes(String(value ?? ""), HTML_TEXT_STRIP_SET, "")
    .replace(/[&<>"']/g, (character) => TEXT_ESCAPES[character]);
}

// Attribute context. Backtick and "=" are escaped in addition to the text set:
// old IE treated a backtick as an attribute delimiter, and escaping "=" plus both
// quote characters keeps the value inert even if it ends up in an unquoted
// attribute. All whitespace becomes a space for the same reason. We only ever
// emit double-quoted attributes.
export function escapeHtmlAttribute(value) {
  return replaceCodes(String(value ?? ""), HTML_ATTR_SPACE_SET, " ")
    .replace(/[&<>"'`=]/g, (character) => ATTR_ESCAPES[character]);
}

// A display name is a phrase (RFC 5322 section 3.4). If it is pure atext plus
// spaces it can be written bare; otherwise it must be a quoted-string with "\"
// and the double quote backslash-escaped (section 3.2.4); and if it is non-ASCII
// it must be an RFC 2047 encoded-word, which per RFC 2047 section 5 may NOT be
// wrapped in quotes, because an encoded-word inside a quoted-string is just
// literal text.
//
// The hyphen is last in the class so it stays literal. Getting that wrong is not
// cosmetic: a "+-/" range would silently admit the comma, and "Smith, Jane
// <a@b.co>" written bare parses as two addresses.
const PHRASE_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/;

export function formatAddress({ displayName, email } = {}, field = "email") {
  const address = normalizeEmail(email, field);
  const name = sanitizeHeaderValue(displayName);
  if (!name) return `<${address}>`;
  if (!isAsciiPrintable(name)) return `${encodeHeaderWord(name)} <${address}>`;
  if (PHRASE_PATTERN.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/[\\"]/g, (character) => `\\${character}`)}" <${address}>`;
}

const MESSAGE_FENCE_OPEN = "--- visitor message below, indented, untrusted ---";
const MESSAGE_FENCE_CLOSE = "--- end of visitor message ---";

// Structure spoofing in plain text. The message body is the one place where
// arbitrary multi-line text lands, so a message containing "Email:
// treasurer@example.org" could be read as one of our own metadata lines, a line
// of dashes could forge the fence, and a bare "-- " line is the RFC 3676 section
// 4.3 signature separator, which makes many clients hide everything after it.
//
// The fix is one rule instead of a blocklist: every line of the message is
// indented by two spaces. Our labels and both fence lines sit at column 0, so no
// line of visitor text can occupy the same position as ours, "-- " is no longer
// at the start of a line, and nothing has to be removed or rewritten. The message
// is also placed last, so even a client that did honour a separator would hide
// nothing of ours.
const indentBlock = (text) => text.split("\n").map((line) => `  ${line}`).join("\n");

function metadataRows({ fields, receivedAt }) {
  const name = [fields.name, fields.last_name].filter(Boolean).join(" ");
  const primary = [["Name", name], ["Email", fields.email], ["Phone", fields.phone], ["Subject", fields.subject]];
  const extra = Object.entries(CONTACT_FIELDS)
    .filter(([field]) => !["name", "last_name", "email", "phone", "subject", "message"].includes(field))
    .map(([field, rule]) => [`${rule.label.slice(0, 1).toUpperCase()}${rule.label.slice(1)}`, fields[field]])
    .filter(([, value]) => value);
  return [...primary, ...extra, ["Received", receivedAt]].filter(([, value]) => value);
}

export function buildPlainTextEmail({ fields, siteLabel, receivedAt } = {}) {
  return [
    `New contact form message from ${sanitizeHeaderValue(siteLabel) || "your website"}.`,
    "",
    ...metadataRows({ fields, receivedAt }).map(([label, value]) => `${label}: ${sanitizeHeaderValue(value)}`),
    "",
    "Reply-To is set to the address above. It was checked for format only - it has not been verified as belonging to the sender.",
    "",
    MESSAGE_FENCE_OPEN,
    indentBlock(fields.message),
    MESSAGE_FENCE_CLOSE,
    ""
  ].join("\n");
}

export function buildHtmlEmail({ fields, siteLabel, receivedAt } = {}) {
  const cells = metadataRows({ fields, receivedAt })
    .map(([label, value]) => `<tr><th align="left">${escapeHtmlText(label)}</th><td>${escapeHtmlText(value)}</td></tr>`)
    .join("");

  // The only URL in the document. It is safe because the address already passed
  // normalizeEmail, which forbids quotes, angle brackets, spaces and every
  // control character, so nothing can escape the quoted attribute; the attribute
  // escape on top of that is belt and braces. No other untrusted value reaches a
  // URL, style or script context, and there is no <script>, no <style> and no
  // inline event handler anywhere in this document.
  const replyHref = escapeHtmlAttribute(`mailto:${fields.email}`);
  const replyTitle = escapeHtmlAttribute(`Reply to ${fields.name}`);

  return [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Contact form message</title></head><body>",
    `<p>New contact form message from ${escapeHtmlText(sanitizeHeaderValue(siteLabel) || "your website")}.</p>`,
    `<table border="0" cellpadding="4"><tbody>${cells}</tbody></table>`,
    `<p><a href="${replyHref}" title="${replyTitle}">Reply to this message</a></p>`,
    "<hr>",
    `<blockquote><p>${escapeHtmlText(fields.message).replace(/\n/g, "<br>")}</p></blockquote>`,
    "</body></html>",
    ""
  ].join("\n");
}

// Assembles the headers and both bodies. `from` is ours and `recipient` is the
// nonprofit's; neither is visitor-controlled. The visitor's address is only ever
// Reply-To - putting it in From would mean sending mail as a stranger from our
// own domain, which fails DMARC alignment and turns the endpoint into a spoofing
// service.
export function buildEmail({ fields, from, recipient, recipientName, siteLabel, subjectPrefix, receivedAt } = {}) {
  const fromAddress = formatAddress({ displayName: from?.name || siteLabel, email: from?.email }, "from");
  const toAddress = formatAddress({ displayName: recipientName, email: recipient }, "recipient");
  const replyTo = formatAddress({ displayName: fields.name, email: fields.email }, "email");

  const prefix = sanitizeHeaderValue(subjectPrefix || siteLabel);
  const body = fields.subject || "New contact form message";
  const subject = encodeHeaderWord(prefix ? `[${prefix}] ${body}` : body);

  return {
    from: fromAddress,
    to: toAddress,
    replyTo,
    subject,
    text: buildPlainTextEmail({ fields, siteLabel, receivedAt }),
    html: buildHtmlEmail({ fields, siteLabel, receivedAt })
  };
}

// RFC 5322 section 2.1 requires CRLF line endings on the wire. Bodies are built
// with LF because that is what provider JSON APIs take; a caller assembling raw
// MIME converts here.
export function toCrlf(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
}

// ---------------------------------------------------------------------------
// 6. Rate-limit bucketing
// ---------------------------------------------------------------------------

const hex16 = (value) => value.toString(16).padStart(4, "0");

function parseIpv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  // Re-emitted from the parsed numbers, so 01.2.3.4 and 1.2.3.4 land in one
  // bucket instead of two.
  return octets.join(".");
}

function parseIpv6(text) {
  // The zone index is local to the sender's machine and carries no routing
  // meaning, so it must not create a separate bucket.
  const body = text.split("%")[0];
  if (!body.includes(":")) return null;

  let head = body;
  const lastColon = body.lastIndexOf(":");
  const tail = body.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = parseIpv4(tail);
    if (!embedded) return null;
    const [a, b, c, d] = embedded.split(".").map(Number);
    head = `${body.slice(0, lastColon + 1)}${hex16((a << 8) | b)}:${hex16((c << 8) | d)}`;
  }

  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups;
  if (right === null) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  }
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

// Canonicalises an address and picks its buckets. An optional [v6]:port or
// v4:port wrapper is accepted because proxies add them.
//
// IPv4 buckets on the exact address (/32). Grouping by /24 was tempting - it
// blunts a small cloud sweep - but an IPv4 /24 routinely spans unrelated
// customers of one ISP, and a single abusive host would then silence 255 innocent
// ones on a form whose entire purpose is letting strangers make contact.
//
// IPv6 buckets on the /64, never the address. A subscriber is normally delegated
// a /64 or larger, so per-address limiting on IPv6 is no limit at all: the
// attacker walks 2^64 fresh addresses inside their own prefix without paying for
// a single extra one. A /64 is the smallest prefix that is reliably one
// subscriber or LAN. Because some ISPs delegate /56 or /48 - leaving 256 or 65536
// distinct /64s to rotate through - a second, coarser /48 key is returned so the
// caller can layer a looser limit on top. Both are needed: /64 alone is evadable,
// /48 alone is over-broad.
export function normalizeIp(value) {
  const text = String(value ?? "").trim();
  // A comma means we were handed an X-Forwarded-For list, which is partly
  // attacker-controlled: any client can prepend hops. Refusing to parse it forces
  // callers to pass a trusted single value (CF-Connecting-IP), and the untrusted
  // case falls into the shared "unknown" bucket instead of minting a fresh bucket
  // per forged hop.
  if (!text || text.includes(",")) return { family: "unknown", canonical: "unknown", bucket: "unknown", block: "unknown" };

  const bracketed = /^\[(.+)\](?::\d{1,5})?$/.exec(text);
  const stripped = bracketed
    ? bracketed[1]
    : (/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text)?.[1] ?? text);

  const v4 = parseIpv4(stripped);
  if (v4) return { family: "ipv4", canonical: v4, bucket: v4, block: v4 };

  const groups = parseIpv6(stripped.toLowerCase());
  if (!groups) return { family: "unknown", canonical: "unknown", bucket: "unknown", block: "unknown" };

  // The IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  // forms are the same host as the plain IPv4 address. Folding them stops an
  // attacker getting a free second bucket per representation.
  const topFiveZero = groups.slice(0, 5).every((group) => group === 0);
  const hasLowBits = groups.slice(6).some((group) => group !== 0);
  if (topFiveZero && hasLowBits && (groups[5] === 0xffff || groups[5] === 0)) {
    const mapped = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
    return { family: "ipv4", canonical: mapped, bucket: mapped, block: mapped };
  }

  return {
    family: "ipv6",
    canonical: groups.map(hex16).join(":"),
    bucket: `${groups.slice(0, 4).map(hex16).join(":")}::/64`,
    block: `${groups.slice(0, 3).map(hex16).join(":")}::/48`
  };
}

// Case-folded, tag-stripped copy of the address, used only inside the HMAC.
//
// Folding case here is safe in a way that folding it for delivery is not: it only
// merges buckets, and the folded string never leaves this function. The "+tag"
// suffix is stripped because "a+1@", "a+2@", ... is a one-line bypass of an
// email-keyed limit at every provider that supports tagging; the cost is that a
// rare local part with a literal "+" shares a bucket with its prefix, which
// affects a rate limit and nothing else. Dots are NOT stripped: that is a
// Gmail-specific rule, and applying it everywhere would merge genuinely different
// people at providers where a dot is an ordinary character.
function bucketEmail(email) {
  const [local, domain] = String(email).split("@");
  return `${local.split("+")[0]}@${domain}`.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

const RATE_LIMIT_SALT_MIN = 16;

// HMAC-SHA256, not SHA-256 over salt + value. There are only 2^32 IPv4
// addresses: an unkeyed digest of one is a lookup table, not a hash, and so is a
// digest of a guessable email address. HMAC with a secret salt is the standard
// keyed construction and, unlike a naive salt||value prefix, is not exposed to
// length extension. A 128-bit prefix keeps KV keys short while leaving collisions
// negligible.
//
// The label goes inside the HMAC as well as outside it (domain separation), so an
// email key can never collide with an IP key that happens to share a string form.
// "|" is the separator because no label contains one.
function bucketKey(label, value, salt) {
  const digest = createHmac("sha256", salt)
    .update(`contact-rate-limit|${label}|${value}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${label}:${digest}`;
}

// Derives every bucketing key for one submission. Deterministic for a given salt,
// so it is testable against pinned digests, and reversible by nobody without the
// salt.
export function rateLimitKeys({ ip, email, siteId, salt } = {}) {
  // Missing security-relevant configuration is a hard failure, not a degraded
  // mode: carrying on would mean either unlimited submissions or raw IPs in
  // storage. It fails identically for every request, so it leaks nothing about
  // any particular site or recipient.
  if (typeof salt !== "string" || salt.length < RATE_LIMIT_SALT_MIN) {
    throw new ContactFormError("missing_rate_limit_salt", "This form is not configured correctly.", null);
  }

  const address = normalizeIp(ip);
  return {
    family: address.family,
    // An absent or unparseable IP shares one strict bucket rather than escaping
    // the limit entirely.
    ipKey: bucketKey("ip", address.bucket, salt),
    ipBlockKey: bucketKey("ipblock", address.block, salt),
    emailKey: email ? bucketKey("email", bucketEmail(email), salt) : null,
    siteKey: siteId ? bucketKey("site", String(siteId), salt) : null
  };
}

// ---------------------------------------------------------------------------
// 7. Log redaction
// ---------------------------------------------------------------------------

// A submission has to be observable - was it accepted, was it a bot, is one
// sender flooding us - without the log becoming a second copy of the mailbox.
// Nothing the visitor typed is reproduced: lengths and salted fingerprints only.
//
// The fingerprints are HMACs under the same secret salt, not plain digests,
// because a SHA-256 of a short message ("please call me") or of a guessable
// address is trivially reversed by anyone who can read the log. Equal
// fingerprints still identify a repeated flood, which is the operational need.
//
// The sender's domain is withheld by default. It is genuinely useful for abuse
// triage and it is also identifying on its own for a small organisation, so it is
// opt-in per call rather than on by default.
export function redactSubmission({
  fields,
  honeypotTripped: tripped,
  outcome,
  discardReason,
  byteLength,
  rateLimit,
  salt,
  includeEmailDomain = false
} = {}) {
  const measure = (value) => (value ? { present: true, length: codePointLength(value) } : { present: false, length: 0 });
  const fingerprint = (value) => (value && salt
    ? createHmac("sha256", salt).update(`contact-log|${value}`, "utf8").digest("hex").slice(0, 16)
    : null);

  const record = {
    event: "contact_submission",
    outcome: outcome ?? null,
    discardReason: discardReason ?? null,
    honeypot: Boolean(tripped),
    bytes: byteLength ?? 0,
    fields: {
      name: measure(fields?.name),
      email: measure(fields?.email),
      phone: measure(fields?.phone),
      subject: measure(fields?.subject),
      message: {
        ...measure(fields?.message),
        lines: fields?.message ? fields.message.split("\n").length : 0
      }
    },
    fingerprints: {
      email: rateLimit?.emailKey ?? (fields?.email ? fingerprint(bucketEmail(fields.email)) : null),
      message: fingerprint(fields?.message),
      subject: fingerprint(fields?.subject)
    },
    ip: rateLimit?.ipKey ?? null,
    ipBlock: rateLimit?.ipBlockKey ?? null,
    site: rateLimit?.siteKey ?? null
  };
  if (includeEmailDomain && fields?.email) record.emailDomain = fields.email.split("@")[1];
  return record;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Runs the whole offline pipeline for one submission and returns what the caller
// should send back plus what it should do internally. It performs no I/O.
//
// Ordering is the security-relevant part. Validation runs FIRST and the honeypot
// decides only afterwards. The tempting order - short-circuit on the honeypot -
// turns the endpoint into a field-name oracle: post a payload that is invalid in
// some other way plus one candidate field filled, and a 200 instead of a 400
// identifies the honeypot. Validating first means a probe gets the same rejection
// either way, and the honeypot then only ever chooses between two outcomes that
// are byte-identical from outside. (The honeypot's *name* is not a secret - it is
// in the DOM. What must stay secret is whether filling it changed anything.)
//
// Delivery-side outcomes - no recipient configured, an unusable recipient
// address, a misconfigured sender - return the accepted response too. That is the
// anti-probing property from docs/nonprofit-platform-features.md: a stranger must
// not be able to tell a hosted nonprofit with a working contact address from one
// without, or discover which addresses exist. The cost is that a configuration
// error silently swallows real messages, which is why every discard carries a
// reason for the owner portal.
export function evaluateSubmission({
  body,
  rawBytes,
  ip,
  salt,
  siteId,
  recipient,
  recipientName,
  from,
  siteLabel,
  subjectPrefix,
  receivedAt,
  includeEmailDomain = false
} = {}) {
  const baseKeys = rateLimitKeys({ ip, siteId, salt });

  let validated = null;
  try {
    validated = validateSubmission(body, { rawBytes });
  } catch (error) {
    if (!(error instanceof ContactFormError)) throw error;
    return {
      status: 400,
      response: rejectionResponse(error),
      outcome: "reject",
      discardReason: error.code,
      email: null,
      rateLimit: baseKeys,
      // Rejected payloads are logged too - fuzzing is exactly what we want to see
      // - but nothing from the payload is copied into the record.
      log: redactSubmission({ fields: null, outcome: "reject", discardReason: error.code, byteLength: 0, rateLimit: baseKeys, salt })
    };
  }

  const { fields, honeypotTripped: tripped, byteLength } = validated;
  const keys = rateLimitKeys({ ip, email: fields.email, siteId, salt });

  const discard = (reason) => ({
    status: 200,
    response: ACCEPTED_RESPONSE,
    outcome: "discard",
    discardReason: reason,
    email: null,
    rateLimit: keys,
    log: redactSubmission({ fields, honeypotTripped: tripped, outcome: "discard", discardReason: reason, byteLength, rateLimit: keys, salt, includeEmailDomain })
  });

  if (tripped) return discard("honeypot");

  let email = null;
  try {
    email = buildEmail({ fields, from, recipient, recipientName, siteLabel, subjectPrefix, receivedAt });
  } catch (error) {
    if (!(error instanceof ContactFormError)) throw error;
    // Our own configuration is broken. The visitor must not learn that, so this
    // looks exactly like a successful send and the reason lives only in the log.
    return discard(error.field === "recipient" ? "recipient_unusable" : "sender_unusable");
  }

  return {
    status: 200,
    response: ACCEPTED_RESPONSE,
    outcome: "deliver",
    discardReason: null,
    email,
    rateLimit: keys,
    log: redactSubmission({ fields, honeypotTripped: false, outcome: "deliver", discardReason: null, byteLength, rateLimit: keys, salt, includeEmailDomain })
  };
}
