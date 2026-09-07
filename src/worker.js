import { withSiteContent } from "../scripts/site-content-worker.js";

// Cache Calc — Cloudflare Worker
// All calculations run client-side; the worker only serves static assets.
const siteHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/feedback') {
      return handleFeedback(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleFeedback(request, env) {
  if (request.method === 'GET') {
    return jsonResponse(await readCounts(env));
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const type = body?.type;
    if (type !== 'love' && type !== 'death') {
      return new Response('Invalid feedback type', { status: 400 });
    }

    const counts = await readCounts(env);
    counts[type] += 1;
    counts.total += 1;
    await env.cachecruncher_feedback.put(type, String(counts[type]));
    await env.cachecruncher_feedback.put('total', String(counts.total));
    return jsonResponse(counts);
  }

  return new Response('Method Not Allowed', { status: 405 });
}

async function readCounts(env) {
  const love = parseCount(await env.cachecruncher_feedback.get('love'));
  const death = parseCount(await env.cachecruncher_feedback.get('death'));
  const storedTotal = parseCount(await env.cachecruncher_feedback.get('total'));
  const total = storedTotal > 0 || (love === 0 && death === 0)
    ? storedTotal
    : love + death;
  return { love, death, total };
}

function parseCount(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}

// The owner's own content, resolved while the page streams. The page already
// contains working values, so this only ever OVERRIDES: a missing document or
// an unreadable bucket serves exactly the page in the repository.
export default withSiteContent(siteHandler, {
  key: "site-content/b97ce281-ffaf-4808-b4d6-9778c1d2d95e.json",
  binding: "MEDIA"
});
