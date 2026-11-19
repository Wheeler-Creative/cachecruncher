// Cache Cruncher solver: the cache, memory, page-table and TLB bit math, and the cache simulator.
//
// This one file is what the page (public/app.js) and the JSON API (src/solve-api.js) both run, so the two can
// never disagree. It is pure: no DOM, no fetch, no clock. It is a plain script, loaded by <script src="/solver.js">
// before app.js; it publishes globalThis.CacheCruncherSolver. The Worker and the tests run it with
// `import "../public/solver.js"`, which executes it the same way.
(() => {
  'use strict';

  const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

  // Every input. `kind: 'size'` is a byte count paired with a unit selector (unitId, which is also the unit
  // parameter in a link or an API call); `kind: 'int'` is a plain integer (bits / counts). Values are always
  // canonical (bytes, bits).
  const FIELDS = {
    cache_size:           { kind: 'size', unitId: 'cache_unit' },
    block_size:           { kind: 'int' },
    num_blocks:           { kind: 'int' },
    associativity:        { kind: 'int' },
    num_sets:             { kind: 'int' },
    index_bits:           { kind: 'int' },
    tag_bits:             { kind: 'int' },
    offset_bits:          { kind: 'int' },
    address_size:         { kind: 'int' },
    addressable_memory:   { kind: 'size', unitId: 'addr_mem_unit' },
    virtual_address_size: { kind: 'int' },
    virtual_memory:       { kind: 'size', unitId: 'virt_mem_unit' },
    pagesize:             { kind: 'size', unitId: 'page_unit' },
    tlb_rows:             { kind: 'int' },
    protection_bits:      { kind: 'int' },
  };
  const FIELD_IDS = Object.keys(FIELDS);
  const UNIT_IDS = Object.fromEntries(FIELD_IDS.filter((id) => FIELDS[id].unitId).map((id) => [FIELDS[id].unitId, id]));

  // Measured in bytes (block_size is a byte count too, it just has no unit selector on the page).
  const BYTE_FIELDS = new Set(['cache_size', 'block_size', 'addressable_memory', 'virtual_memory', 'pagesize']);
  // The bit counts that need a power of two underneath them.
  const POW2_FIELDS = ['block_size', 'num_sets', 'addressable_memory', 'virtual_memory', 'pagesize', 'tlb_rows'];

  const LABELS = {
    cache_size: 'cache size',
    block_size: 'block size',
    num_blocks: 'number of blocks',
    associativity: 'associativity',
    num_sets: 'number of sets',
    index_bits: 'index bits',
    tag_bits: 'tag bits',
    offset_bits: 'offset bits',
    address_size: 'address bits',
    addressable_memory: 'physical memory',
    virtual_address_size: 'virtual address bits',
    virtual_memory: 'virtual memory',
    pagesize: 'page size',
    tlb_rows: 'TLB rows',
    protection_bits: 'protection bits',
  };
  const EXTRA_LABELS = {
    num_tags: 'number of tags',
    tag_space_bytes: 'tag storage',
    valid_bits_bytes: 'valid-bit storage',
    total_overhead_bytes: 'total overhead',
    page_offset_bits: 'page offset bits',
    virtual_pages: 'virtual pages',
    physical_pages: 'physical pages',
    phys_page_bits: 'physical page bits',
    vpn_bits: 'virtual page number bits',
    page_table_bits: 'page table size in bits',
    page_table_bytes: 'page table size',
    tlb_index: 'TLB index bits',
    tlb_tag: 'TLB tag bits',
  };

  // What an output needs, to say so when it could not be worked out.
  const NEEDS = {
    num_blocks: 'cache_size + block_size, or num_sets + associativity',
    num_sets: 'num_blocks + associativity, or index_bits',
    index_bits: 'num_sets, or address_size + tag_bits + offset_bits',
    offset_bits: 'block_size, or address_size + tag_bits + index_bits',
    tag_bits: 'address_size + index_bits + offset_bits',
    page_offset_bits: 'pagesize (a power of two)',
    virtual_pages: 'virtual_address_size + pagesize',
    physical_pages: 'address_size (or addressable_memory) + pagesize',
    phys_page_bits: 'address_size + pagesize',
    vpn_bits: 'virtual_address_size + pagesize',
    page_table_bytes: 'virtual_address_size + address_size + pagesize + protection_bits',
    tlb_index: 'tlb_rows (a power of two)',
    tlb_tag: 'tlb_rows + virtual_address_size + pagesize',
  };
  const CACHE_INPUTS = ['cache_size', 'block_size', 'num_blocks', 'associativity', 'num_sets', 'index_bits', 'tag_bits', 'offset_bits'];
  const MEMORY_INPUTS = ['pagesize', 'virtual_address_size', 'virtual_memory', 'tlb_rows', 'protection_bits'];
  const CACHE_OUTPUTS = ['num_blocks', 'num_sets', 'index_bits', 'offset_bits', 'tag_bits'];
  const MEMORY_OUTPUTS = ['page_offset_bits', 'virtual_pages', 'physical_pages', 'phys_page_bits', 'vpn_bits', 'page_table_bytes', 'tlb_index', 'tlb_tag'];

  // ─────────────────────────────── helpers ─────────────────────────────────
  // Exact for any size: the usual `x & (x - 1)` works on 32 bits only, so 12 GB looked like a power of two.
  const isPow2 = (x) => Number.isInteger(x) && x > 0 && (BigInt(x) & (BigInt(x) - 1n)) === 0n;
  const ilog2 = (x) => {
    if (!Number.isFinite(x) || x <= 0) return null;
    const l = Math.log2(x);
    const r = Math.round(l);
    return Math.abs(l - r) < 1e-9 ? r : l; // exact for powers of 2
  };
  const isWhole = (x) => Math.abs(x - Math.round(x)) < 1e-9;
  const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Plain digits for working shown in words (no locale grouping, so the same text everywhere).
  function num(x) {
    if (!Number.isFinite(x)) return String(x);
    if (isWhole(x)) return String(Math.round(x));
    return String(Number(x.toFixed(4)));
  }
  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return null;
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    let i = 0;
    let val = n;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    const s = val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : Math.round(val).toString();
    return `${parseFloat(s)} ${units[i]}`;
  }
  function fmtInt(n) {
    if (n == null || !Number.isFinite(n)) return null;
    if (Math.abs(n - Math.round(n)) < 1e-9) return Math.round(n).toLocaleString('en-US');
    return Number(n.toFixed(4)).toString();
  }
  // A byte count as the largest unit that divides it exactly: 32768 -> { value: 32, unit: 'KB' }.
  function splitSize(bytes, units = ['GB', 'MB', 'KB']) {
    if (Number.isInteger(bytes) && bytes > 0) {
      for (const unit of units) {
        const factor = SIZE_FACTORS[unit.toLowerCase()];
        if (bytes % factor === 0) return { value: bytes / factor, unit };
      }
    }
    return { value: bytes, unit: 'B' };
  }

  // ─────────────────────────────── rules ───────────────────────────────────
  // Each rule: { rel, target, inputs[], compute(v) -> number|null, formula, show(v) }.
  // Both directions of every relation are listed so any side can drive. `rel` names the relation, so a
  // disagreement is reported once; `formula` and `show` are the working in words.
  const RULES = [
    // block_size <-> offset_bits
    { rel: 'offset', target: 'block_size', inputs: ['offset_bits'],
      compute: (v) => v.offset_bits != null ? 2 ** v.offset_bits : null,
      formula: '2^offset bits', show: (v) => `2^${num(v.offset_bits)}` },
    { rel: 'offset', target: 'offset_bits', inputs: ['block_size'],
      compute: (v) => isPow2(v.block_size) ? ilog2(v.block_size) : null,
      formula: 'log2(block size)', show: (v) => `log2(${num(v.block_size)})` },

    // num_sets <-> index_bits
    { rel: 'sets', target: 'num_sets', inputs: ['index_bits'],
      compute: (v) => v.index_bits != null ? 2 ** v.index_bits : null,
      formula: '2^index bits', show: (v) => `2^${num(v.index_bits)}` },
    { rel: 'sets', target: 'index_bits', inputs: ['num_sets'],
      compute: (v) => isPow2(v.num_sets) ? ilog2(v.num_sets) : null,
      formula: 'log2(number of sets)', show: (v) => `log2(${num(v.num_sets)})` },

    // cache_size = num_blocks x block_size  (three-way)
    { rel: 'cache-size', target: 'num_blocks', inputs: ['cache_size', 'block_size'],
      compute: (v) => v.cache_size != null && v.block_size > 0 ? v.cache_size / v.block_size : null,
      formula: 'cache size / block size', show: (v) => `${num(v.cache_size)} / ${num(v.block_size)}` },
    { rel: 'cache-size', target: 'cache_size', inputs: ['num_blocks', 'block_size'],
      compute: (v) => v.num_blocks != null && v.block_size != null ? v.num_blocks * v.block_size : null,
      formula: 'number of blocks × block size', show: (v) => `${num(v.num_blocks)} × ${num(v.block_size)}` },
    { rel: 'cache-size', target: 'block_size', inputs: ['cache_size', 'num_blocks'],
      compute: (v) => v.cache_size != null && v.num_blocks > 0 ? v.cache_size / v.num_blocks : null,
      formula: 'cache size / number of blocks', show: (v) => `${num(v.cache_size)} / ${num(v.num_blocks)}` },

    // num_blocks = num_sets x associativity  (three-way)
    { rel: 'blocks-sets', target: 'num_blocks', inputs: ['num_sets', 'associativity'],
      compute: (v) => v.num_sets != null && v.associativity != null ? v.num_sets * v.associativity : null,
      formula: 'number of sets × associativity', show: (v) => `${num(v.num_sets)} × ${num(v.associativity)}` },
    { rel: 'blocks-sets', target: 'num_sets', inputs: ['num_blocks', 'associativity'],
      compute: (v) => v.num_blocks != null && v.associativity > 0 ? v.num_blocks / v.associativity : null,
      formula: 'number of blocks / associativity', show: (v) => `${num(v.num_blocks)} / ${num(v.associativity)}` },
    { rel: 'blocks-sets', target: 'associativity', inputs: ['num_blocks', 'num_sets'],
      compute: (v) => v.num_blocks != null && v.num_sets > 0 ? v.num_blocks / v.num_sets : null,
      formula: 'number of blocks / number of sets', show: (v) => `${num(v.num_blocks)} / ${num(v.num_sets)}` },

    // address_size = tag_bits + index_bits + offset_bits  (four-way)
    { rel: 'address-split', target: 'tag_bits', inputs: ['address_size', 'index_bits', 'offset_bits'],
      compute: (v) => v.address_size != null && v.index_bits != null && v.offset_bits != null
        ? v.address_size - v.index_bits - v.offset_bits : null,
      formula: 'address bits − index bits − offset bits',
      show: (v) => `${num(v.address_size)} − ${num(v.index_bits)} − ${num(v.offset_bits)}` },
    { rel: 'address-split', target: 'address_size', inputs: ['tag_bits', 'index_bits', 'offset_bits'],
      compute: (v) => v.tag_bits != null && v.index_bits != null && v.offset_bits != null
        ? v.tag_bits + v.index_bits + v.offset_bits : null,
      formula: 'tag bits + index bits + offset bits',
      show: (v) => `${num(v.tag_bits)} + ${num(v.index_bits)} + ${num(v.offset_bits)}` },
    { rel: 'address-split', target: 'index_bits', inputs: ['address_size', 'tag_bits', 'offset_bits'],
      compute: (v) => v.address_size != null && v.tag_bits != null && v.offset_bits != null
        ? v.address_size - v.tag_bits - v.offset_bits : null,
      formula: 'address bits − tag bits − offset bits',
      show: (v) => `${num(v.address_size)} − ${num(v.tag_bits)} − ${num(v.offset_bits)}` },
    { rel: 'address-split', target: 'offset_bits', inputs: ['address_size', 'tag_bits', 'index_bits'],
      compute: (v) => v.address_size != null && v.tag_bits != null && v.index_bits != null
        ? v.address_size - v.tag_bits - v.index_bits : null,
      formula: 'address bits − tag bits − index bits',
      show: (v) => `${num(v.address_size)} − ${num(v.tag_bits)} − ${num(v.index_bits)}` },

    // address_size <-> addressable_memory
    { rel: 'phys-memory', target: 'addressable_memory', inputs: ['address_size'],
      compute: (v) => v.address_size != null ? 2 ** v.address_size : null,
      formula: '2^address bits', show: (v) => `2^${num(v.address_size)}` },
    { rel: 'phys-memory', target: 'address_size', inputs: ['addressable_memory'],
      compute: (v) => isPow2(v.addressable_memory) ? ilog2(v.addressable_memory) : null,
      formula: 'log2(physical memory)', show: (v) => `log2(${num(v.addressable_memory)})` },

    // virtual_address_size <-> virtual_memory
    { rel: 'virt-memory', target: 'virtual_memory', inputs: ['virtual_address_size'],
      compute: (v) => v.virtual_address_size != null ? 2 ** v.virtual_address_size : null,
      formula: '2^virtual address bits', show: (v) => `2^${num(v.virtual_address_size)}` },
    { rel: 'virt-memory', target: 'virtual_address_size', inputs: ['virtual_memory'],
      compute: (v) => isPow2(v.virtual_memory) ? ilog2(v.virtual_memory) : null,
      formula: 'log2(virtual memory)', show: (v) => `log2(${num(v.virtual_memory)})` },
  ];

  // ─────────────────────────────── solver ──────────────────────────────────
  // Fills in everything that follows from the known values (id -> number, canonical units). A known value is
  // never changed: only empty fields are filled, each by the first rule that can, so the answer does not
  // depend on the order things were derived in. Returns the values and, for each field a rule filled in, the
  // rule that did it (in the order they fired).
  function solve(given) {
    const v = {};
    for (const id of FIELD_IDS) v[id] = given[id] ?? null;
    const derivation = new Map();
    let order = 0;
    let changed = true;
    let passes = 0;
    while (changed && passes < 30) {
      changed = false;
      passes++;
      for (const rule of RULES) {
        if (v[rule.target] != null) continue;
        if (!rule.inputs.every((i) => v[i] != null)) continue;
        const result = rule.compute(v);
        if (result == null || !Number.isFinite(result) || result < 0) continue;
        v[rule.target] = result;
        derivation.set(rule.target, { rule, order: order++ });
        changed = true;
      }
    }
    return { values: v, derivation };
  }

  // ─────────────────────────── derived display ─────────────────────────────
  // Output-only values (not editable) from the solved canonical state.
  function deriveExtras(v) {
    const e = {};
    e.num_tags = v.num_blocks;
    e.tag_space_bytes = (v.num_blocks != null && v.tag_bits != null)
      ? (v.num_blocks * v.tag_bits) / 8 : null;
    e.valid_bits_bytes = v.num_blocks != null ? v.num_blocks / 8 : null;
    e.total_overhead_bytes = (e.tag_space_bytes != null && e.valid_bits_bytes != null)
      ? e.tag_space_bytes + e.valid_bits_bytes : null;

    e.page_offset_bits = isPow2(v.pagesize) ? ilog2(v.pagesize) : null;

    e.virtual_pages = (v.virtual_address_size != null && e.page_offset_bits != null)
      ? 2 ** (v.virtual_address_size - e.page_offset_bits) : null;

    e.physical_pages = (v.addressable_memory != null && v.pagesize > 0)
      ? v.addressable_memory / v.pagesize : null;

    e.phys_page_bits = (v.address_size != null && e.page_offset_bits != null)
      ? v.address_size - e.page_offset_bits
      : (e.physical_pages != null && isPow2(e.physical_pages) ? ilog2(e.physical_pages) : null);

    e.vpn_bits = (v.virtual_address_size != null && e.page_offset_bits != null)
      ? v.virtual_address_size - e.page_offset_bits : null;

    e.page_table_bits = (e.virtual_pages != null && e.phys_page_bits != null && v.protection_bits != null)
      ? e.virtual_pages * (e.phys_page_bits + v.protection_bits) : null;
    e.page_table_bytes = e.page_table_bits != null ? e.page_table_bits / 8 : null;

    e.tlb_index = isPow2(v.tlb_rows) ? ilog2(v.tlb_rows) : null;
    e.tlb_tag = (e.vpn_bits != null && e.tlb_index != null)
      ? e.vpn_bits - e.tlb_index : null;

    return e;
  }

  // The two result lists the page paints: [label, text or null].
  function resultRows(v, e) {
    const bits = (n) => (n != null ? `${fmtInt(n)} bits` : null);
    return {
      cache: [
        ['Cache Size',           fmtBytes(v.cache_size)],
        ['Block Size',           fmtBytes(v.block_size)],
        ['Associativity',        fmtInt(v.associativity)],
        ['Number of Sets',       fmtInt(v.num_sets)],
        ['Number of Blocks',     fmtInt(v.num_blocks)],
        ['Index Bits',           fmtInt(v.index_bits)],
        ['Offset Bits',          fmtInt(v.offset_bits)],
        ['Tag Bits',             fmtInt(v.tag_bits)],
        ['Number of Tags',       fmtInt(e.num_tags)],
        ['Tag Storage',          fmtBytes(e.tag_space_bytes)],
        ['Valid-Bit Storage',    fmtBytes(e.valid_bits_bytes)],
        ['Total Overhead',       fmtBytes(e.total_overhead_bytes)],
      ],
      memory: [
        ['Physical Address Space',  bits(v.address_size)],
        ['Physical Memory',         fmtBytes(v.addressable_memory)],
        ['Virtual Address Space',   bits(v.virtual_address_size)],
        ['Virtual Memory',          fmtBytes(v.virtual_memory)],
        ['Page Size',               fmtBytes(v.pagesize)],
        ['Page Offset Bits',        fmtInt(e.page_offset_bits)],
        ['Virtual Pages',           fmtInt(e.virtual_pages)],
        ['Physical Pages',          fmtInt(e.physical_pages)],
        ['Physical Page Bits',      fmtInt(e.phys_page_bits)],
        ['Virtual Page # bits',     fmtInt(e.vpn_bits)],
        ['Page Table Size',         fmtBytes(e.page_table_bytes)],
        ['TLB Index Bits',          fmtInt(e.tlb_index)],
        ['TLB Tag Bits',            fmtInt(e.tlb_tag)],
      ],
    };
  }

  // How an address splits into fields, most significant first: [{ name, bits, high, low }]. Null until every
  // width is a whole number that fits.
  function addressLayouts(v, e) {
    const whole = (...xs) => xs.every((x) => x != null && isWhole(x) && x >= 0);
    const layout = (total, parts) => {
      let high = total - 1;
      return parts.map(([name, bits]) => {
        const part = { name, bits, high: bits > 0 ? high : null, low: bits > 0 ? high - bits + 1 : null };
        high -= bits;
        return part;
      });
    };
    const out = { cache: null, virtual: null, tlb: null };
    if (whole(v.address_size, v.tag_bits, v.index_bits, v.offset_bits)
      && close(v.tag_bits + v.index_bits + v.offset_bits, v.address_size)) {
      out.cache = layout(v.address_size, [['Tag', v.tag_bits], ['Index', v.index_bits], ['Offset', v.offset_bits]]);
    }
    if (whole(v.virtual_address_size, e.vpn_bits, e.page_offset_bits)) {
      out.virtual = layout(v.virtual_address_size, [['Virtual page number', e.vpn_bits], ['Page offset', e.page_offset_bits]]);
      if (whole(e.tlb_tag, e.tlb_index)) {
        out.tlb = layout(v.virtual_address_size, [['TLB tag', e.tlb_tag], ['TLB index', e.tlb_index], ['Page offset', e.page_offset_bits]]);
      }
    }
    return out;
  }

  // ───────────────────────────── explanation ───────────────────────────────
  // A step is { label, formula, work, result, text }: "label = formula = work = result."
  const step = (label, formula, work, result) => ({
    label, formula, work, result, text: `${label} = ${formula} = ${work} = ${result}.`,
  });
  const shown = (id, value) => (BYTE_FIELDS.has(id) ? `${fmtBytes(value)} (${num(value)} bytes)` : num(value));

  function givenStep(given) {
    const items = FIELD_IDS.filter((id) => given[id] != null).map((id) => ({ label: LABELS[id], value: shown(id, given[id]) }));
    if (!items.length) return [];
    return [{ given: items, text: `Given: ${items.map((item) => `${item.label} = ${item.value}`).join(', ')}.` }];
  }

  // In the order the rules fired, which is always a valid order to read them in. The memory sizes go last:
  // nothing else is worked out from them, so a reader meets index and tag bits before "2^32 bytes".
  function ruleSteps(v, derivation) {
    const late = (target) => (target === 'addressable_memory' || target === 'virtual_memory' ? 1 : 0);
    return [...derivation.entries()]
      .sort((a, b) => late(a[0]) - late(b[0]) || a[1].order - b[1].order)
      .map(([target, { rule }]) => step(
        cap(LABELS[target]), rule.formula, rule.show(v), `${num(v[target])}${BYTE_FIELDS.has(target) ? ' bytes' : ''}`,
      ));
  }

  function extraSteps(v, e) {
    const out = [];
    const add = (key, formula, work, unit = '') => {
      if (e[key] != null && Number.isFinite(e[key])) out.push(step(cap(EXTRA_LABELS[key]), formula, work, `${num(e[key])}${unit}`));
    };
    if (e.num_tags != null) {
      out.push({ label: 'Number of tags', formula: 'number of blocks (one tag per block)', work: null, result: num(e.num_tags),
        text: `Number of tags = number of blocks (one tag per block) = ${num(e.num_tags)}.` });
    }
    add('tag_space_bytes', 'number of blocks × tag bits / 8', `${num(v.num_blocks)} × ${num(v.tag_bits)} / 8`, ' bytes');
    add('valid_bits_bytes', 'number of blocks × 1 valid bit / 8', `${num(v.num_blocks)} / 8`, ' bytes');
    add('total_overhead_bytes', 'tag storage + valid-bit storage', `${num(e.tag_space_bytes)} + ${num(e.valid_bits_bytes)}`, ' bytes');
    add('page_offset_bits', 'log2(page size)', `log2(${num(v.pagesize)})`);
    add('virtual_pages', '2^(virtual address bits − page offset bits)', `2^(${num(v.virtual_address_size)} − ${num(e.page_offset_bits)})`);
    add('physical_pages', 'physical memory / page size', `${num(v.addressable_memory)} / ${num(v.pagesize)}`);
    if (v.address_size != null && e.page_offset_bits != null) {
      add('phys_page_bits', 'address bits − page offset bits', `${num(v.address_size)} − ${num(e.page_offset_bits)}`);
    } else {
      add('phys_page_bits', 'log2(physical pages)', `log2(${num(e.physical_pages)})`);
    }
    add('vpn_bits', 'virtual address bits − page offset bits', `${num(v.virtual_address_size)} − ${num(e.page_offset_bits)}`);
    add('page_table_bits', 'virtual pages × (physical page bits + protection bits)',
      `${num(e.virtual_pages)} × (${num(e.phys_page_bits)} + ${num(v.protection_bits)})`, ' bits');
    add('page_table_bytes', 'page table bits / 8', `${num(e.page_table_bits)} / 8`, ' bytes');
    add('tlb_index', 'log2(TLB rows)', `log2(${num(v.tlb_rows)})`);
    add('tlb_tag', 'virtual page number bits − TLB index bits', `${num(e.vpn_bits)} − ${num(e.tlb_index)}`);
    return out;
  }

  // Values that cannot all be true at once: a relation whose result differs from a value already there.
  function findConflicts(v) {
    const seen = new Set();
    const out = [];
    for (const rule of RULES) {
      if (seen.has(rule.rel)) continue;
      if (![...rule.inputs, rule.target].every((i) => v[i] != null)) continue;
      const result = rule.compute(v);
      if (result == null || !Number.isFinite(result)) continue;
      if (!close(v[rule.target], result)) {
        seen.add(rule.rel);
        out.push(`${cap(LABELS[rule.target])} is ${num(v[rule.target])}, but ${rule.formula} = ${rule.show(v)} = ${num(result)}.`);
      }
    }
    return out;
  }

  // Things that are not wrong arithmetic but mean the numbers do not describe a real cache or memory.
  function findWarnings(v, e) {
    const out = [];
    for (const id of FIELD_IDS) {
      if (v[id] == null) continue;
      if (!isWhole(v[id])) {
        out.push(`${cap(LABELS[id])} came out as ${num(v[id])}, which is not a whole number, so these values do not describe a valid configuration.`);
      } else if (POW2_FIELDS.includes(id) && !isPow2(v[id])) {
        out.push(`${cap(LABELS[id])} ${num(v[id])} is not a power of two, so the bit counts that depend on it cannot be derived.`);
      }
    }
    const negative = new Set();
    for (const rule of RULES) {
      if (v[rule.target] != null || negative.has(rule.target)) continue;
      if (!rule.inputs.every((i) => v[i] != null)) continue;
      const result = rule.compute(v);
      if (result != null && Number.isFinite(result) && result < 0) {
        negative.add(rule.target);
        out.push(`${cap(LABELS[rule.target])} would be negative (${rule.formula} = ${rule.show(v)} = ${num(result)}), so these values do not fit together.`);
      }
    }
    for (const key of ['phys_page_bits', 'vpn_bits', 'tlb_tag']) {
      if (e[key] != null && e[key] < 0) {
        out.push(`${cap(EXTRA_LABELS[key])} would be negative (${num(e[key])}), so these values do not fit together.`);
      }
    }
    return out;
  }

  // The outputs a caller probably wanted but could not get, with what each needs.
  function notDetermined(given, v, e) {
    const out = {};
    const check = (ids, source) => {
      for (const id of ids) if (source[id] == null) out[id] = NEEDS[id];
    };
    if (CACHE_INPUTS.some((id) => given[id] != null)) check(CACHE_OUTPUTS, v);
    if (MEMORY_INPUTS.some((id) => given[id] != null)) check(MEMORY_OUTPUTS, e);
    return out;
  }

  function describe(given) {
    const { values, derivation } = solve(given);
    const extras = deriveExtras(values);
    return {
      given: { ...given },
      values,
      extras,
      derivation,
      rows: resultRows(values, extras),
      layouts: addressLayouts(values, extras),
      steps: [...givenStep(given), ...ruleSteps(values, derivation), ...extraSteps(values, extras)],
      conflicts: findConflicts(values),
      warnings: findWarnings(values, extras),
      notDetermined: notDetermined(given, values, extras),
    };
  }

  // What the API reports for a set of known values. They all count equally, so values that disagree are
  // reported (`conflicts`) rather than one silently winning.
  function analyze(given) {
    const known = {};
    for (const id of FIELD_IDS) if (given[id] != null) known[id] = given[id];
    return describe(known);
  }

  // What the page shows for the values a visitor typed, newest edit first. The most recent edits win: going
  // from newest to oldest, a typed value is kept unless the newer ones already settle that field to something
  // else, in which case it is `overridden` (with the value that replaces it, and why). Everything else is then
  // derived from the kept values only, so nothing stale is ever fed back in.
  function settle(typed, newestFirst = []) {
    const order = [...new Set([...newestFirst, ...FIELD_IDS])].filter((id) => typed[id] != null);
    const kept = {};
    const dropped = [];
    for (const id of order) {
      const before = solve(kept).values;
      if (before[id] != null) {
        if (close(before[id], typed[id])) kept[id] = typed[id];
        else dropped.push(id);
        continue;
      }
      const trial = { ...kept, [id]: typed[id] };
      if (findConflicts(solve(trial).values).length) dropped.push(id);
      else kept[id] = typed[id];
    }
    const result = describe(kept);
    result.overridden = {};
    for (const id of dropped) {
      const value = result.values[id];
      const rule = result.derivation.get(id)?.rule;
      result.overridden[id] = {
        typed: typed[id],
        value,
        text: value != null && rule
          ? `${cap(LABELS[id])} was ${shown(id, typed[id])}, but ${rule.formula} = ${rule.show(result.values)} = ${shown(id, value)} from the values entered more recently.`
          : `${cap(LABELS[id])} ${shown(id, typed[id])} does not fit with the values entered more recently.`,
      };
    }
    return result;
  }

  // ───────────────────────── reading values from text ─────────────────────────
  // The same parameters work in an API call and in a link to the calculator:
  //   ?cache_size=32KB&block_size=64&associativity=4&address_size=32
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
  // A unit word to its byte count, or null. (Own keys only: "constructor" is not a unit.)
  const factorOf = (word) => (Object.hasOwn(SIZE_FACTORS, word) ? SIZE_FACTORS[word] : null);

  // "32", "32KB", "32 kb", "1,024", "0.5MB", "1e3" -> { value, suffix } (suffix lower-cased), or null.
  function parseQuantity(raw) {
    const text = raw.trim().replace(/,(?=\d{3}(?:\D|$))/g, '');
    const match = /^(\d+(?:\.\d+)?|\.\d+)(?:e([+-]?\d+))?\s*([a-z]*)$/i.exec(text);
    if (!match) return null;
    return { value: Number(match[1] + (match[2] ? `e${match[2]}` : '')), suffix: match[3].toLowerCase() };
  }

  // A URLSearchParams -> { given, ignored } (values in bytes and bits), or { error } saying what to fix.
  function parseInputs(searchParams) {
    const names = [...new Set(searchParams.keys())];
    if (names.length > MAX_PARAMS) return { error: `Too many parameters (${names.length}); the most accepted is ${MAX_PARAMS}.` };
    const known = new Set([...FIELD_IDS, ...Object.keys(UNIT_IDS)]);
    const ignored = names.filter((name) => !known.has(name)).map((name) => name.slice(0, MAX_VALUE_LENGTH));
    const given = {};

    for (const name of names) {
      if (!known.has(name)) continue;
      const values = searchParams.getAll(name);
      if (values.length > 1) return { error: `"${name}" was given more than once; give it one value.` };
      if (values[0].length > MAX_VALUE_LENGTH) return { error: `"${name}" is too long to be a number.` };
    }

    for (const id of FIELD_IDS) {
      const raw = searchParams.get(id);
      if (raw === null || raw.trim() === '') continue;
      const sizeLike = FIELDS[id].kind === 'size' || id === 'block_size';
      const quantity = parseQuantity(raw);
      if (!quantity) {
        return { error: `"${id}" must be a non-negative number${sizeLike ? ' with an optional unit, like 32KB' : ''} (got "${raw}").` };
      }
      let factor = 1;
      const unitName = FIELDS[id].unitId;
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

  // Known values -> the query string that carries them: "cache_size=32KB&block_size=64".
  function toQuery(given) {
    const parts = [];
    for (const id of FIELD_IDS) {
      const value = given[id];
      if (value == null || !Number.isFinite(value)) continue;
      let text = num(value);
      if (FIELDS[id].kind === 'size') {
        const size = splitSize(value, ['TB', 'GB', 'MB', 'KB']);
        text = size.unit === 'B' ? num(value) : `${num(size.value)}${size.unit}`;
      }
      parts.push(`${id}=${encodeURIComponent(text)}`);
    }
    return parts.join('&');
  }

  // ───────────────────────────── cache simulator ─────────────────────────────
  // A cache of the solved geometry, stepped one access at a time. Assumptions, stated wherever it is shown:
  //   - byte addresses; a block is found by tag in its set;
  //   - on a miss an empty way is used first, otherwise a block is replaced by `policy`:
  //     'lru' = least recently used, 'fifo' = the one loaded longest ago;
  //   - a write marks the block dirty; replacing a dirty block is a write-back;
  //   - the TLB is direct-mapped (row = VPN mod rows), and the page table is a stand-in that maps
  //     virtual page n to physical page n mod (number of physical pages), so nothing ever page-faults.
  const SIM_POLICIES = { lru: 'LRU (least recently used)', fifo: 'FIFO (first in, first out)' };
  const wholeOrNull = (value) => (Number.isFinite(value) && isWhole(value) ? Math.round(value) : null);

  // Solved values -> the simulator's configuration, or null when they do not describe a cache it can run.
  function simConfig(v) {
    const blockSize = wholeOrNull(v.block_size);
    const numSets = wholeOrNull(v.num_sets);
    const associativity = wholeOrNull(v.associativity);
    const addressSize = wholeOrNull(v.address_size);
    const numBlocks = wholeOrNull(v.num_blocks);
    if (!blockSize || !numSets || !associativity || !addressSize || !numBlocks) return null;
    if (!isPow2(blockSize) || !isPow2(numSets)) return null;
    if (numBlocks !== numSets * associativity) return null;
    const offsetBits = ilog2(blockSize);
    const indexBits = ilog2(numSets);
    if (addressSize < offsetBits + indexBits || addressSize > 53) return null;

    const pageSize = wholeOrNull(v.pagesize);
    const virtualAddressSize = wholeOrNull(v.virtual_address_size);
    const tlbRows = wholeOrNull(v.tlb_rows);
    const pageOffsetBits = pageSize && isPow2(pageSize) ? ilog2(pageSize) : null;
    const physicalPages = pageOffsetBits != null && addressSize >= pageOffsetBits ? 2 ** (addressSize - pageOffsetBits) : null;
    const vpnBits = virtualAddressSize != null && pageOffsetBits != null && virtualAddressSize >= pageOffsetBits
      ? virtualAddressSize - pageOffsetBits : null;
    return {
      blockSize, numSets, associativity, addressSize, numBlocks,
      offsetBits, indexBits, tagBits: addressSize - indexBits - offsetBits,
      memoryBytes: 2 ** addressSize,
      pageSize: pageOffsetBits != null ? pageSize : null,
      pageOffsetBits,
      physicalPages,
      virtualAddressSize: vpnBits != null && virtualAddressSize <= 53 ? virtualAddressSize : null,
      vpnBits: vpnBits != null && virtualAddressSize <= 53 ? vpnBits : null,
      tlbRows: tlbRows && isPow2(tlbRows) ? tlbRows : null,
    };
  }
  const simSupportsVirtual = (config) => Boolean(config && config.pageSize && config.physicalPages && config.vpnBits != null);
  const simKey = (config, policy) => JSON.stringify([config, policy]);

  function simCreate(config, policy = 'lru') {
    return {
      config,
      policy: Object.hasOwn(SIM_POLICIES, policy) ? policy : 'lru',
      sets: new Map(),   // set index -> ways, made the first time the set is touched
      tlb: new Map(),    // TLB row -> { tag, vpn, physicalPage }
      clock: 0,
      last: null,
      stats: { accesses: 0, hits: 0, misses: 0, replacements: 0, writeBacks: 0, tlbHits: 0, tlbMisses: 0 },
    };
  }
  function simWays(sim, setIndex) {
    let ways = sim.sets.get(setIndex);
    if (!ways) {
      ways = Array.from({ length: sim.config.associativity }, (_, way) => ({
        way, valid: false, tag: null, blockNumber: null, baseAddress: null, dirty: false, loadedAt: 0, lastUsed: 0,
      }));
      sim.sets.set(setIndex, ways);
    }
    return ways;
  }

  // A virtual address through the TLB and the stand-in page table.
  function simTranslate(sim, virtualAddress) {
    const { config } = sim;
    const vpn = Math.floor(virtualAddress / config.pageSize);
    const pageOffset = virtualAddress % config.pageSize;
    const tlbIndex = config.tlbRows ? vpn % config.tlbRows : null;
    const tlbTag = config.tlbRows ? Math.floor(vpn / config.tlbRows) : null;
    const entry = tlbIndex != null ? sim.tlb.get(tlbIndex) : null;
    const tlbHit = tlbIndex != null ? Boolean(entry && entry.tag === tlbTag) : null;
    const physicalPage = tlbHit ? entry.physicalPage : vpn % config.physicalPages;
    if (tlbIndex != null) {
      if (tlbHit) sim.stats.tlbHits += 1;
      else {
        sim.stats.tlbMisses += 1;
        sim.tlb.set(tlbIndex, { tag: tlbTag, vpn, physicalPage });
      }
    }
    return {
      mode: 'virtual', inputAddress: virtualAddress, virtualAddress, vpn, pageOffset, physicalPage,
      physicalAddress: (physicalPage * config.pageSize) + pageOffset,
      tlbIndex, tlbTag, tlbHit,
    };
  }

  // One read or write of a physical address. Returns what happened and updates the cache.
  function simAccess(sim, address, operation = 'read', translation = null) {
    const { config } = sim;
    const blockNumber = Math.floor(address / config.blockSize);
    const setIndex = blockNumber % config.numSets;
    const tag = Math.floor(blockNumber / config.numSets);
    const offset = address % config.blockSize;
    const ways = simWays(sim, setIndex);
    sim.clock += 1;

    let line = ways.find((entry) => entry.valid && entry.tag === tag);
    const outcome = line ? 'Hit' : 'Miss';
    let evicted = null;
    if (!line) {
      line = ways.find((entry) => !entry.valid);
      if (!line) {
        const age = sim.policy === 'fifo' ? 'loadedAt' : 'lastUsed';
        line = ways.reduce((oldest, entry) => (entry[age] < oldest[age] ? entry : oldest));
        evicted = { tag: line.tag, blockNumber: line.blockNumber, dirty: line.dirty };
        sim.stats.replacements += 1;
        if (line.dirty) sim.stats.writeBacks += 1;
      }
      line.valid = true;
      line.tag = tag;
      line.blockNumber = blockNumber;
      line.baseAddress = blockNumber * config.blockSize;
      line.dirty = false;
      line.loadedAt = sim.clock;
    }
    line.lastUsed = sim.clock;
    if (operation === 'write') line.dirty = true;
    sim.stats.accesses += 1;
    sim.stats[outcome === 'Hit' ? 'hits' : 'misses'] += 1;

    const access = {
      number: sim.stats.accesses,
      address,
      inputAddress: translation?.inputAddress ?? address,
      mode: translation?.mode ?? 'physical',
      operation,
      virtualAddress: translation?.virtualAddress ?? null,
      vpn: translation?.vpn ?? null,
      pageOffset: translation?.pageOffset ?? null,
      physicalPage: translation?.physicalPage ?? null,
      tlbIndex: translation?.tlbIndex ?? null,
      tlbTag: translation?.tlbTag ?? null,
      tlbHit: translation?.tlbHit ?? null,
      blockNumber, setIndex, tag, offset,
      way: line.way,
      outcome,
      dirty: line.dirty,
      evicted,
      baseAddress: blockNumber * config.blockSize,
    };
    sim.last = access;
    return access;
  }

  // One address as text: hex (0x3F), binary (0b111111) or decimal. Null when it is not one or does not fit.
  function parseAddress(raw, bitWidth) {
    const text = String(raw).trim().replace(/_/g, '');
    let value = null;
    if (/^0x[0-9a-f]+$/i.test(text)) value = Number.parseInt(text.slice(2), 16);
    else if (/^0b[01]+$/i.test(text)) value = Number.parseInt(text.slice(2), 2);
    else if (/^\d+$/.test(text)) value = Number.parseInt(text, 10);
    if (value == null || !Number.isSafeInteger(value) || value < 0) return null;
    if (bitWidth != null && value > (2 ** bitWidth) - 1) return null;
    return value;
  }

  // A pasted list of addresses, separated by spaces, commas or new lines. R (read) or W (write) before an
  // address sets that one access; without it the access is `defaultOperation`.
  //   "0x00 0x04 W 0x08, 12"  ->  read 0, read 4, write 8, read 12
  const TRACE_LIMIT = 500;
  function parseTrace(text, bitWidth, defaultOperation = 'read') {
    const accesses = [];
    const errors = [];
    let operation = null;
    for (const token of String(text).split(/[\s,;]+/).filter(Boolean)) {
      if (/^(r|read|l|load)$/i.test(token)) { operation = 'read'; continue; }
      if (/^(w|write|s|store)$/i.test(token)) { operation = 'write'; continue; }
      const address = parseAddress(token, bitWidth);
      if (address == null) {
        if (errors.length < 5) errors.push(token.slice(0, 24));
      } else if (accesses.length < TRACE_LIMIT) {
        accesses.push({ address, operation: operation ?? defaultOperation });
      } else {
        return { accesses, errors, truncated: true };
      }
      operation = null;
    }
    return { accesses, errors, truncated: false };
  }

  globalThis.CacheCruncherSolver = Object.freeze({
    UNITS, FIELDS, FIELD_IDS, UNIT_IDS, BYTE_FIELDS, LABELS, EXTRA_LABELS, NEEDS,
    isPow2, ilog2, fmtBytes, fmtInt, num, splitSize,
    solve, deriveExtras, resultRows, addressLayouts, analyze, settle,
    parseInputs, toQuery,
    SIM_POLICIES, TRACE_LIMIT, simConfig, simSupportsVirtual, simKey, simCreate, simWays, simTranslate, simAccess,
    parseAddress, parseTrace,
  });
})();
