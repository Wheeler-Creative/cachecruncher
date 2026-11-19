// Checks the shared solver (public/solver.js), the JSON API built on it (src/solve-api.js) and the wiring that
// makes the page and the API run the same file. Run by `npm run check`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleOpenApi, handleSolve, PARAMS, VALUE_NAMES, DERIVED_NAMES } from '../src/solve-api.js';

const Solver = globalThis.CacheCruncherSolver;
assert.ok(Solver, 'public/solver.js publishes globalThis.CacheCruncherSolver');
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

let checks = 0;
function check(name, fn) {
  try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
async function checkAsync(name, fn) {
  try { await fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

const call = async (query, init = {}) => {
  const response = await handleSolve(new Request(`https://cachecruncher.com/api/solve${query}`, init));
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
};

// ───────────────────────────── the solver ─────────────────────────────
check('32 KB, 4-way, 64-byte blocks, 32-bit addresses', () => {
  const r = Solver.analyze({ cache_size: 32768, block_size: 64, associativity: 4, address_size: 32 });
  assert.equal(r.values.num_blocks, 512);
  assert.equal(r.values.num_sets, 128);
  assert.equal(r.values.offset_bits, 6);
  assert.equal(r.values.index_bits, 7);
  assert.equal(r.values.tag_bits, 19);
  assert.equal(r.values.addressable_memory, 2 ** 32);
  assert.equal(r.extras.tag_space_bytes, 1216);
  assert.equal(r.extras.valid_bits_bytes, 64);
  assert.equal(r.extras.total_overhead_bytes, 1280);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.steps.includes('Number of blocks = cache size / block size = 32768 / 64 = 512.'));
  assert.ok(r.steps.includes('Tag bits = address bits − index bits − offset bits = 32 − 7 − 6 = 19.'));
});

check('direct-mapped and fully associative', () => {
  const direct = Solver.analyze({ cache_size: 16384, block_size: 32, associativity: 1, address_size: 32 });
  assert.deepEqual([direct.values.num_sets, direct.values.index_bits, direct.values.offset_bits, direct.values.tag_bits], [512, 9, 5, 18]);
  const full = Solver.analyze({ cache_size: 1024, block_size: 16, num_sets: 1, address_size: 16 });
  assert.deepEqual([full.values.num_blocks, full.values.associativity, full.values.index_bits, full.values.tag_bits], [64, 64, 0, 12]);
});

check('solves backwards from the bit split', () => {
  const r = Solver.analyze({ index_bits: 7, offset_bits: 6, tag_bits: 19 });
  assert.equal(r.values.address_size, 32);
  assert.equal(r.values.num_sets, 128);
  assert.equal(r.values.block_size, 64);
  assert.equal(r.values.addressable_memory, 2 ** 32);
});

check('page table and TLB', () => {
  const r = Solver.analyze({ address_size: 32, virtual_address_size: 32, pagesize: 4096, protection_bits: 4, tlb_rows: 64 });
  const e = r.extras;
  assert.deepEqual([e.page_offset_bits, e.vpn_bits, e.phys_page_bits, e.tlb_index, e.tlb_tag], [12, 20, 20, 6, 14]);
  assert.equal(e.virtual_pages, 2 ** 20);
  assert.equal(e.physical_pages, 2 ** 20);
  assert.equal(e.page_table_bytes, 3 * 2 ** 20);
  assert.ok(r.steps.includes('Page table size = page table bits / 8 = 25165824 / 8 = 3145728 bytes.'));
});

check('a size over 32 bits that is not a power of two is not treated as one', () => {
  // 12 GB = 3 * 2^32. The old `x & (x - 1)` test saw only the low 32 bits and called it a power of two.
  assert.equal(Solver.isPow2(12 * 1024 ** 3), false);
  assert.equal(Solver.isPow2(2 ** 40), true);
  assert.equal(Solver.isPow2(1), true);
  assert.equal(Solver.isPow2(0), false);
  assert.equal(Solver.isPow2(0.5), false);
  const r = Solver.analyze({ addressable_memory: 12 * 1024 ** 3 });
  assert.equal(r.values.address_size, null);
  assert.ok(r.warnings.some((w) => w.includes('not a power of two')));
});

check('contradictory values are reported once, in words', () => {
  const r = Solver.analyze({ cache_size: 32768, block_size: 64, num_blocks: 500 });
  assert.deepEqual(r.conflicts, ['Number of blocks is 500, but cache size / block size = 32768 / 64 = 512.']);
  const split = Solver.analyze({ address_size: 32, index_bits: 7, offset_bits: 6, tag_bits: 20 });
  assert.equal(split.conflicts.length, 1);
});

check('values that cannot fit together are warned about', () => {
  const r = Solver.analyze({ address_size: 10, index_bits: 7, offset_bits: 6 });
  assert.equal(r.values.tag_bits, null);
  assert.ok(r.warnings.some((w) => w.startsWith('Tag bits would be negative')));
  const odd = Solver.analyze({ num_blocks: 512, associativity: 3 });
  assert.ok(odd.warnings.some((w) => w.includes('not a whole number')));
});

check('says what is missing and what it needs', () => {
  const r = Solver.analyze({ cache_size: 32768, block_size: 64, associativity: 4 });
  assert.equal(r.notDetermined.tag_bits, Solver.NEEDS.tag_bits);
  assert.equal(r.notDetermined.num_sets, undefined);
});

check('the page keeps its rule: the most recent edit wins, and the focused field is never touched', () => {
  const values = { cache_size: 32768, block_size: 128, num_blocks: 512 }; // block_size just edited from 64
  const recency = { cache_size: 1, block_size: 3, num_blocks: -1 };      // num_blocks was only derived
  assert.equal(Solver.solve(values, recency).values.num_blocks, 256);
  assert.equal(Solver.solve(values, recency, 'num_blocks').values.num_blocks, 512);
  const equal = Solver.solve({ cache_size: 32768, block_size: 64, num_blocks: 500 }, { cache_size: 1, block_size: 1, num_blocks: 1 });
  assert.equal(equal.values.num_blocks, 500); // equal weight: nothing silently wins
});

// ───────────────────────────── the API ─────────────────────────────
await checkAsync('GET /api/solve answers the worked example', async () => {
  const { response, body } = await call('?cache_size=32KB&block_size=64&associativity=4&address_size=32');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('cache-control'), /public/);
  assert.equal(body.ok, true);
  assert.deepEqual(
    [body.values.num_blocks, body.values.num_sets, body.values.offset_bits, body.values.index_bits, body.values.tag_bits],
    [512, 128, 6, 7, 19],
  );
  assert.equal(body.values.cache_size_bytes, 32768);
  assert.equal(body.derived.tag_storage_bytes, 1216);
  assert.equal(body.formatted['Cache Size'], '32 KB');
  assert.equal(body.formatted['Tag Bits'], '19');
  assert.ok(body.steps.length >= 6);
  assert.deepEqual(body.not_determined, {});
});

await checkAsync('sizes accept units, a separate unit parameter, spaces, commas and fractions', async () => {
  const want = (await call('?cache_size=32768')).body.values.cache_size_bytes;
  assert.equal(want, 32768);
  for (const query of ['?cache_size=32KB', '?cache_size=32kb', '?cache_size=32%20KB', '?cache_size=32+KB', '?cache_size=32KiB',
    '?cache_size=32&cache_unit=KB', '?cache_size=32KB&cache_unit=kb', '?cache_size=0.03125MB', '?cache_size=32,768']) {
    const { response, body } = await call(query);
    assert.equal(response.status, 200, query);
    assert.equal(body.values.cache_size_bytes, 32768, query);
  }
  assert.equal((await call('?block_size=64B')).body.values.block_size_bytes, 64);
  assert.equal((await call('?addressable_memory=4GB')).body.values.address_bits, 32);
  assert.equal((await call('?virtual_memory=1TB')).body.values.virtual_address_bits, 40);
  assert.equal((await call('?pagesize=4&page_unit=KB')).body.derived.page_offset_bits, 12);
});

await checkAsync('values that contradict each other are 422 with the conflict', async () => {
  const { response, body } = await call('?cache_size=32KB&block_size=64&num_blocks=500');
  assert.equal(response.status, 422);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'inputs_conflict');
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.values, undefined);
});

await checkAsync('warnings ride along on a good answer', async () => {
  const { response, body } = await call('?cache_size=32KB&block_size=64&associativity=4&foo=1');
  assert.equal(response.status, 200);
  assert.ok(body.warnings.includes('Ignored unknown parameter: foo.'));
  const odd = (await call('?block_size=48&cache_size=3KB')).body;
  assert.ok(odd.warnings.some((w) => w.includes('not a power of two')));
});

await checkAsync('malformed requests are 400 and say what to fix', async () => {
  const bad = {
    '': 'no_values',
    '?foo=1': 'no_values',
    '?cache_size=abc': 'bad_parameter',
    '?cache_size=-5': 'bad_parameter',
    '?cache_size=32XB': 'bad_parameter',
    '?cache_size=32constructor': 'bad_parameter',
    '?cache_size=1&cache_unit=constructor': 'bad_parameter',
    '?cache_size=32KB&cache_unit=MB': 'bad_parameter',
    '?associativity=4KB': 'bad_parameter',
    '?cache_size=1&cache_size=2': 'bad_parameter',
    '?cache_size=1e40': 'bad_parameter',
    [`?cache_size=${'9'.repeat(41)}`]: 'bad_parameter',
    [`?${Array.from({ length: 41 }, (_, i) => `p${i}=1`).join('&')}`]: 'bad_parameter',
  };
  for (const [query, error] of Object.entries(bad)) {
    const { response, body } = await call(query);
    assert.equal(response.status, 400, query);
    assert.equal(body.ok, false, query);
    assert.equal(body.error, error, query);
    assert.ok(body.message.length > 10, query);
    assert.equal(response.headers.get('cache-control'), 'no-store', query);
  }
});

await checkAsync('methods', async () => {
  const options = await call('?cache_size=1', { method: 'OPTIONS' });
  assert.equal(options.response.status, 204);
  assert.equal(options.response.headers.get('access-control-allow-origin'), '*');
  const head = await call('?cache_size=32KB&block_size=64', { method: 'HEAD' });
  assert.equal(head.response.status, 200);
  assert.equal(head.body, null);
  const post = await handleSolve(new Request('https://cachecruncher.com/api/solve?cache_size=1', { method: 'POST' }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
});

await checkAsync('every value the solver can produce has a name in the answer', async () => {
  assert.deepEqual(Object.keys(VALUE_NAMES).sort(), [...Solver.FIELD_IDS].sort());
  assert.deepEqual(Object.keys(DERIVED_NAMES).sort(), Object.keys(Solver.deriveExtras({})).sort());
  const everything = '?cache_size=32KB&block_size=64&associativity=4&address_size=32&virtual_address_size=32&pagesize=4KB&protection_bits=4&tlb_rows=64';
  const { body } = await call(everything);
  assert.deepEqual(body.not_determined, {});
  for (const name of Object.values(VALUE_NAMES)) assert.equal(typeof body.values[name], 'number', name);
  for (const name of Object.values(DERIVED_NAMES)) assert.equal(typeof body.derived[name], 'number', name);
});

// ───────────────────────────── the description ─────────────────────────────
await checkAsync('GET /openapi.json describes exactly what the endpoint reads', async () => {
  const response = await handleOpenApi(new Request('https://cachecruncher.com/openapi.json'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const doc = await response.json();
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(doc.servers, [{ url: 'https://cachecruncher.com' }]);
  const operation = doc.paths['/api/solve'].get;
  assert.equal(operation.operationId, 'solveCacheMemoryBits');
  // ChatGPT Actions reject an operation description over 300 characters or a parameter description over 700.
  assert.ok(operation.description.length <= 300, `operation description is ${operation.description.length} characters`);
  const units = Solver.FIELD_IDS.map((id) => Solver.FIELDS[id].unitId).filter(Boolean);
  assert.deepEqual(operation.parameters.map((p) => p.name).sort(), [...Solver.FIELD_IDS, ...units].sort());
  assert.deepEqual(Object.keys(PARAMS).sort(), [...Solver.FIELD_IDS].sort());
  for (const parameter of operation.parameters) {
    assert.ok(parameter.description && parameter.description.length <= 700, parameter.name);
    assert.equal(parameter.in, 'query');
  }
  for (const status of ['200', '400', '422']) assert.ok(operation.responses[status], status);
  assert.ok(doc.components.schemas.Solved && doc.components.schemas.Refused);
  // Every documented example must itself be accepted.
  for (const parameter of operation.parameters.filter((p) => p.example !== undefined)) {
    const { response: r } = await call(`?${parameter.name}=${encodeURIComponent(parameter.example)}`);
    assert.equal(r.status, 200, `${parameter.name}=${parameter.example}`);
  }
  assert.equal((await handleOpenApi(new Request('https://cachecruncher.com/openapi.json', { method: 'POST' }))).status, 405);
});

// ───────────────────────────── the wiring ─────────────────────────────
check('the page loads the solver before app.js, and app.js has no second copy of the math', () => {
  const scripts = read('layout/scripts.html');
  assert.ok(scripts.includes('<script src="/solver.js"></script>'));
  assert.ok(scripts.indexOf('/solver.js') < scripts.indexOf('/app.js'), 'solver.js must come first');
  const app = read('public/app.js');
  assert.ok(app.includes('globalThis.CacheCruncherSolver'));
  assert.ok(!/const RULES\b/.test(app), 'the rules live in public/solver.js');
  assert.ok(!/function deriveExtras\b/.test(app), 'deriveExtras lives in public/solver.js');
  assert.ok(read('wrangler.jsonc').includes('"!/solver.js"'), 'solver.js is served straight from assets, like app.js');
  assert.ok(read('src/site-routes.js').includes("from './solve-api.js'"));
});

check('every input the solver knows has a field on the page', () => {
  const html = read('public/index.html');
  for (const id of Solver.FIELD_IDS) {
    assert.ok(html.includes(`id="${id}"`), `${id} has an input`);
    const unit = Solver.FIELDS[id].unitId;
    if (unit) assert.ok(html.includes(`id="${unit}"`), `${unit} has a selector`);
  }
});

console.log(`Solver and API checks passed (${checks}).`);
