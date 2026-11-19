// The calculator's JSON API, for AI assistants and anything else that can fetch a URL.
//
//   GET /api/solve?cache_size=32KB&block_size=64&associativity=4&address_size=32
//       answers the same bit math the page does, with the working shown in words;
//   GET /openapi.json
//       describes it, so a ChatGPT Action or a function-calling app can import it.
//
// All the math is public/solver.js, the file the page itself runs. This file only reads the query string,
// shapes the answer and describes it. It stores nothing and calls nothing.
import '../public/solver.js';

const Solver = globalThis.CacheCruncherSolver;

const SITE_ORIGIN = 'https://cachecruncher.com';
const MAX_PARAMS = 40;
const MAX_VALUE_LENGTH = 40;
const MAX_MAGNITUDE = 1e30;

// 1 KB = 1024 bytes throughout: this is computer architecture, not a hard-drive box.
const SIZE_FACTORS = {
  b: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

// Name in the answer for each internal field. A name that holds a byte count says so.
export const VALUE_NAMES = {
  cache_size: 'cache_size_bytes',
  block_size: 'block_size_bytes',
  num_blocks: 'num_blocks',
  associativity: 'associativity',
  num_sets: 'num_sets',
  index_bits: 'index_bits',
  offset_bits: 'offset_bits',
  tag_bits: 'tag_bits',
  address_size: 'address_bits',
  addressable_memory: 'physical_memory_bytes',
  virtual_address_size: 'virtual_address_bits',
  virtual_memory: 'virtual_memory_bytes',
  pagesize: 'page_size_bytes',
  tlb_rows: 'tlb_rows',
  protection_bits: 'protection_bits',
};
export const DERIVED_NAMES = {
  num_tags: 'num_tags',
  tag_space_bytes: 'tag_storage_bytes',
  valid_bits_bytes: 'valid_bit_storage_bytes',
  total_overhead_bytes: 'total_overhead_bytes',
  page_offset_bits: 'page_offset_bits',
  virtual_pages: 'virtual_pages',
  physical_pages: 'physical_pages',
  phys_page_bits: 'physical_page_bits',
  vpn_bits: 'virtual_page_number_bits',
  page_table_bits: 'page_table_bits',
  page_table_bytes: 'page_table_bytes',
  tlb_index: 'tlb_index_bits',
  tlb_tag: 'tlb_tag_bits',
};
const OUTPUT_NAMES = { ...VALUE_NAMES, ...DERIVED_NAMES };

// What each query parameter means. This table is also the OpenAPI parameter list, so the two cannot drift.
const SIZE_HELP = 'A size: a number with an optional unit, like "32KB". 1 KB = 1024 bytes. A bare number is bytes';
export const PARAMS = {
  cache_size: { example: '32KB', text: `Total cache capacity. ${SIZE_HELP} (or give the unit in cache_unit).` },
  block_size: { example: '64', text: 'Block (cache line) size in bytes, a power of two, like "64" or "64B".' },
  num_blocks: { example: 512, text: 'Number of blocks (lines) in the cache: cache size / block size.' },
  associativity: { example: 4, text: 'Blocks per set (ways). 1 means direct-mapped; equal to num_blocks means fully associative.' },
  num_sets: { example: 128, text: 'Number of sets, a power of two: number of blocks / associativity.' },
  index_bits: { example: 7, text: 'Index bits: log2(number of sets).' },
  tag_bits: { example: 19, text: 'Tag bits: address bits - index bits - offset bits.' },
  offset_bits: { example: 6, text: 'Block offset bits: log2(block size in bytes).' },
  address_size: { example: 32, text: 'Physical address width in bits, like 32 or 64.' },
  addressable_memory: { example: '4GB', text: `Physical memory size, a power of two. ${SIZE_HELP} (or give the unit in addr_mem_unit). Gives address_size.` },
  virtual_address_size: { example: 32, text: 'Virtual address width in bits.' },
  virtual_memory: { example: '4GB', text: `Virtual memory size, a power of two. ${SIZE_HELP} (or give the unit in virt_mem_unit). Gives virtual_address_size.` },
  pagesize: { example: '4KB', text: `Page size, a power of two. ${SIZE_HELP} (or give the unit in page_unit).` },
  tlb_rows: { example: 64, text: 'Number of TLB rows (entries), a power of two. Gives TLB index and tag bits.' },
  protection_bits: { example: 4, text: 'Extra bits stored per page-table entry (valid, dirty, permissions). Needed for the page table size.' },
};
const UNIT_PARAMS = Object.fromEntries(
  Solver.FIELD_IDS.filter((id) => Solver.FIELDS[id].unitId).map((id) => [Solver.FIELDS[id].unitId, id]),
);
const UNIT_TEXT = 'Unit for a bare number: B, KB, MB, GB or TB (1 KB = 1024 bytes). Not needed when the size already has a unit.';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status, request, cacheable) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS,
    },
  });
}

function refuse(request, status, error, message, extra = {}) {
  return json({ ok: false, error, message, ...extra, docs: `${SITE_ORIGIN}/openapi.json` }, status, request, false);
}

// A unit word to its byte count, or null. (Own keys only: "constructor" is not a unit.)
const factorOf = (word) => (Object.hasOwn(SIZE_FACTORS, word) ? SIZE_FACTORS[word] : null);

// "32", "32KB", "32 kb", "1,024", "0.5MB", "1e3" -> { value, suffix } (suffix lower-cased), or null.
function parseQuantity(raw) {
  const text = raw.trim().replace(/,(?=\d{3}(?:\D|$))/g, '');
  const match = /^(\d+(?:\.\d+)?|\.\d+)(?:e([+-]?\d+))?\s*([a-z]*)$/i.exec(text);
  if (!match) return null;
  return { value: Number(match[1] + (match[2] ? `e${match[2]}` : '')), suffix: match[3].toLowerCase() };
}

// The query string -> { given, ignored } (values in bytes and bits), or { error } saying what to fix.
function readQuery(searchParams) {
  const names = [...new Set(searchParams.keys())];
  if (names.length > MAX_PARAMS) return { error: `Too many parameters (${names.length}); the most accepted is ${MAX_PARAMS}.` };
  const known = new Set([...Solver.FIELD_IDS, ...Object.keys(UNIT_PARAMS)]);
  const ignored = names.filter((name) => !known.has(name)).map((name) => name.slice(0, MAX_VALUE_LENGTH));
  const given = {};

  for (const name of names) {
    if (!known.has(name)) continue;
    const values = searchParams.getAll(name);
    if (values.length > 1) return { error: `"${name}" was given more than once; give it one value.` };
    if (values[0].length > MAX_VALUE_LENGTH) return { error: `"${name}" is too long to be a number.` };
  }

  for (const id of Solver.FIELD_IDS) {
    const raw = searchParams.get(id);
    if (raw === null || raw.trim() === '') continue;
    const sizeLike = Solver.FIELDS[id].kind === 'size' || id === 'block_size';
    const quantity = parseQuantity(raw);
    if (!quantity) {
      return { error: `"${id}" must be a non-negative number${sizeLike ? ' with an optional unit, like 32KB' : ''} (got "${raw}").` };
    }
    let factor = 1;
    const unitName = Solver.FIELDS[id].unitId;
    const unitRaw = unitName ? searchParams.get(unitName) : null;
    const unitSuffix = unitRaw && unitRaw.trim() !== '' ? unitRaw.trim().toLowerCase() : '';
    if (quantity.suffix) {
      if (!sizeLike) return { error: `"${id}" takes a plain number, not a unit (got "${raw}").` };
      factor = factorOf(quantity.suffix);
      if (factor === null) return { error: `"${id}" has an unknown unit "${quantity.suffix}"; use B, KB, MB, GB or TB.` };
      if (unitSuffix && factorOf(unitSuffix) !== factor) {
        return { error: `"${id}" has the unit ${quantity.suffix.toUpperCase()} but ${unitName} says ${unitRaw}; give the unit once.` };
      }
    } else if (unitSuffix) {
      factor = factorOf(unitSuffix);
      if (factor === null) return { error: `"${unitName}" must be B, KB, MB, GB or TB (got "${unitRaw}").` };
    }
    const value = quantity.value * factor;
    if (!Number.isFinite(value) || value > MAX_MAGNITUDE) return { error: `"${id}" is too large.` };
    given[id] = value;
  }
  return { given, ignored };
}

function present(source, names) {
  const out = {};
  for (const [internal, external] of Object.entries(names)) {
    const value = source[internal];
    if (value != null && Number.isFinite(value)) out[external] = value;
  }
  return out;
}

export function handleSolve(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS', ...CORS } });
  }

  const query = readQuery(new URL(request.url).searchParams);
  if (query.error) return refuse(request, 400, 'bad_parameter', query.error);
  if (!Object.keys(query.given).length) {
    return refuse(request, 400, 'no_values', query.ignored.length
      ? `No recognised parameters. Ignored: ${query.ignored.join(', ')}. Valid: ${Solver.FIELD_IDS.join(', ')}.`
      : 'Give at least one known value, for example /api/solve?cache_size=32KB&block_size=64&associativity=4&address_size=32',
    { example: `${SITE_ORIGIN}/api/solve?cache_size=32KB&block_size=64&associativity=4&address_size=32` });
  }

  const result = Solver.analyze(query.given);
  const warnings = [...result.warnings];
  if (query.ignored.length) warnings.push(`Ignored unknown parameter${query.ignored.length > 1 ? 's' : ''}: ${query.ignored.join(', ')}.`);

  if (result.conflicts.length) {
    return json({
      ok: false,
      error: 'inputs_conflict',
      message: 'The values given cannot all be true at once. Check them and try again.',
      conflicts: result.conflicts,
      warnings,
      docs: `${SITE_ORIGIN}/openapi.json`,
    }, 422, request, true);
  }

  const formatted = {};
  for (const [label, text] of [...result.rows.cache, ...result.rows.memory]) if (text != null) formatted[label] = text;
  const notDetermined = {};
  for (const [internal, needs] of Object.entries(result.notDetermined)) notDetermined[OUTPUT_NAMES[internal]] = `needs ${needs}`;

  return json({
    ok: true,
    values: present(result.values, VALUE_NAMES),
    derived: present(result.extras, DERIVED_NAMES),
    formatted,
    steps: result.steps,
    warnings,
    not_determined: notDetermined,
    notes: 'Names ending in _bytes are byte counts and names ending in _bits are bit counts (1 KB = 1024 bytes). Computed by Cache Cruncher, https://cachecruncher.com.',
    docs: `${SITE_ORIGIN}/openapi.json`,
  }, 200, request, true);
}

// ─────────────────────────────── OpenAPI ────────────────────────────────
function openApiDocument() {
  const parameters = [
    ...Solver.FIELD_IDS.map((id) => {
      const sizeLike = Solver.FIELDS[id].kind === 'size' || id === 'block_size';
      return {
        name: id,
        in: 'query',
        required: false,
        description: PARAMS[id].text,
        schema: sizeLike ? { type: 'string' } : { type: 'number', minimum: 0 },
        example: PARAMS[id].example,
      };
    }),
    ...Object.entries(UNIT_PARAMS).map(([unit, field]) => ({
      name: unit,
      in: 'query',
      required: false,
      description: `${UNIT_TEXT} Applies to ${field}.`,
      schema: { type: 'string', enum: ['B', 'KB', 'MB', 'GB', 'TB'] },
    })),
  ];
  const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cache Cruncher API',
      version: '1.0.0',
      description: 'Exact computer-architecture bit math: cache geometry (sets, blocks, index/tag/offset bits, tag storage), physical and virtual address spaces, page tables and TLBs. Use it instead of working log2 and unit conversions out by hand. Give any combination of known values; every other value that can be derived comes back with the working. Free, no key, nothing stored.',
      contact: { name: 'Cache Cruncher', url: SITE_ORIGIN },
    },
    servers: [{ url: SITE_ORIGIN }],
    paths: {
      '/api/solve': {
        get: {
          operationId: 'solveCacheMemoryBits',
          summary: 'Solve cache, memory, page-table and TLB bit math',
          description: 'Give any known values. Returns every other value that can be derived, with step-by-step working. Sizes accept KB/MB/GB suffixes (1 KB = 1024 bytes).',
          parameters,
          responses: {
            200: {
              description: 'Solved values with the working.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Solved' } } },
            },
            400: {
              description: 'A parameter was missing or malformed. The message says which.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Refused' } } },
            },
            422: {
              description: 'The values given contradict each other. The conflicts say how.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Refused' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Solved: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [true] },
            values: { type: 'object', description: 'The cache and memory values, given or derived. _bytes names are bytes, _bits names are bits.', additionalProperties: { type: 'number' } },
            derived: { type: 'object', description: 'Extra results: tag and valid-bit storage, page and TLB values.', additionalProperties: { type: 'number' } },
            formatted: { ...stringMap, description: 'The same results as the web calculator shows them, like "32 KB".' },
            steps: { type: 'array', description: 'The working, one line per step.', items: { type: 'string' } },
            warnings: { type: 'array', description: 'Values that are not powers of two, not whole numbers, or ignored parameters.', items: { type: 'string' } },
            not_determined: { ...stringMap, description: 'Results that could not be worked out, with what each needs.' },
            notes: { type: 'string' },
            docs: { type: 'string' },
          },
          required: ['ok', 'values', 'steps'],
        },
        Refused: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: { type: 'string' },
            message: { type: 'string' },
            conflicts: { type: 'array', items: { type: 'string' } },
            warnings: { type: 'array', items: { type: 'string' } },
            docs: { type: 'string' },
          },
          required: ['ok', 'error', 'message'],
        },
      },
    },
  };
}

export function handleOpenApi(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS', ...CORS } });
  }
  return json(openApiDocument(), 200, request, true);
}
