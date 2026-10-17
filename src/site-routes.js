// CacheCruncher's own server code: the love/death feedback counter in KV. The platform Worker
// (src/worker.js) calls siteRoutes first for every request; returning null hands the request to the
// platform, which serves the pages and the shared runtime (owner values, checks).
export async function siteRoutes(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/feedback') {
    return handleFeedback(request, env);
  }
  return null;
}

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
