// One shape for every line a build step prints.
//
// WHY. Each stage invented its own format as it was written:
//
//   a11y ok    /about-us/ (desktop + mobile clean)
//   content ok    /donate/ — 25% to 62%
//   overflow fixed  /links-for-help/ — was 394px past the edge
//   Recorded 1 repaired page(s) so the work survives a retry: /links-for-help/
//
// Same information, four layouts, three vocabularies for "it worked", and one
// stage with no prefix at all. A build log is read when something has gone
// wrong, usually in a hurry, usually by scrolling - so the columns need to line
// up and the outcome word needs to mean the same thing everywhere.
//
//   [a11y]     repaired  /links-for-help/    3 attempts, color-contrast
//   [content]  improved  /donate/            coverage 25% -> 62%
//   [overflow] unfixed   /links-for-help/    394px in a 390px viewport
//   [content]  summary   3 improved, 1 still short
//
// Deliberately plain text on stdout/stderr: GitHub Actions renders this raw,
// and a log you can grep beats a log you must parse.

const STEP_WIDTH = 10;
const OUTCOME_WIDTH = 9;
const ROUTE_WIDTH = 26;

// The complete vocabulary. Adding an outcome here is a deliberate act, which is
// the point - "fixed" and "repaired" and "ok" meaning three different things in
// three files is how the old logs got unreadable.
// EVERYTHING GOES TO STDOUT EXCEPT A FAILURE.
//
// The first version sent warnings to stderr, which read correctly on a terminal
// and scrambled the moment the log was piped: stdout and stderr are separately
// buffered, so a "rejected" line surfaced above the "attempt" it belonged to and
// an indented detail line floated above its parent. A build log whose lines are
// out of order is worse than one without severity, because the reader draws the
// wrong causal conclusion. Only fail goes to stderr, so it can still be isolated.
const OUTCOMES = {
  ok: { channel: "log" },          // already fine, nothing done
  repaired: { channel: "log" },    // was broken, now is not
  improved: { channel: "log" },    // better, but not all the way
  attempt: { channel: "log" },     // starting a try
  skip: { channel: "log" },        // could not look at it
  unfixed: { channel: "log" },     // looked, tried, could not fix
  rejected: { channel: "log" },    // a fix was offered and refused
  fail: { channel: "error" },      // this stops the build
  summary: { channel: "log" },     // one per step, at the end
  note: { channel: "log" }
};

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * A logger for one pipeline step.
 *
 * @param {string} step  short name, e.g. "a11y", "content", "overflow"
 */
export function buildLog(step) {
  const label = pad(`[${step}]`, STEP_WIDTH);

  const emit = (outcome, route, detail) => {
    const shape = OUTCOMES[outcome] || OUTCOMES.note;
    const parts = [label, pad(outcome, OUTCOME_WIDTH)];
    // A message with no route is a step-level line; do not leave a hole.
    if (route) parts.push(pad(route, ROUTE_WIDTH));
    const line = `${parts.join(" ")}${detail ? ` ${detail}` : ""}`.trimEnd();
    console[shape.channel](line);
  };

  const api = {
    /** Nothing needed doing. */
    ok: (route, detail) => emit("ok", route, detail),
    /** It was wrong and now it is right. */
    repaired: (route, detail) => emit("repaired", route, detail),
    /** Better than it was, still not where we want it. */
    improved: (route, detail) => emit("improved", route, detail),
    /** About to try something that costs time or money. */
    attempt: (route, detail) => emit("attempt", route, detail),
    /** Could not even look at it. Not the same as "it passed". */
    skip: (route, reason) => emit("skip", route, reason),
    /** Looked, tried, could not fix. Recorded, not hidden. */
    unfixed: (route, detail) => emit("unfixed", route, detail),
    /** A candidate fix was offered and refused, with the reason. */
    rejected: (route, reason) => emit("rejected", route, reason),
    /** This one stops the build. */
    fail: (route, detail) => emit("fail", route, detail),
    /** Free-form, for context that is not about one route. */
    note: (detail) => emit("note", "", detail),
    /** Exactly one per step, so a long log can be skimmed by summary lines. */
    summary: (detail) => emit("summary", "", detail),
    /** Indented continuation under the line above. */
    detail: (text) => {
      console.log(`${" ".repeat(STEP_WIDTH + 1)}${text}`);
    }
  };
  return api;
}

/** The outcome vocabulary, for tests that assert a step uses it. */
export const LOG_OUTCOMES = Object.keys(OUTCOMES);
