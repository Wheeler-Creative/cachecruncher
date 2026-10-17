// This website's own API. It answers requests under /api/x/ and nothing else.
//
// It runs on its own, apart from the website's server: env holds only the keys saved for this
// website (env.NAME), and it can call other services with fetch. It cannot import other files.
export default {
  async fetch(request, env, ctx) {
    return new Response("Not found", { status: 404 });
  }
};
