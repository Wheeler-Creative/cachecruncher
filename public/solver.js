// Cache Cruncher solver: the cache, memory, page-table and TLB bit math.
//
// This one file is what the page (public/app.js) and the JSON API (src/solve-api.js) both run, so the two can
// never disagree. It is pure: no DOM, no fetch, no clock. It is a plain script, loaded by <script src="/solver.js">
// before app.js; it publishes globalThis.CacheCruncherSolver. The Worker and the tests run it with
// `import "../public/solver.js"`, which executes it the same way.
(() => {
  'use strict';

  const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

  // Every input. `kind: 'size'` is a byte count paired with a unit selector (unitId, which is also the API's
  // unit parameter); `kind: 'int'` is a plain integer (bits / counts). Values are always canonical (bytes, bits).
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

  // What an output needs, for the API to say when it could not work one out.
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
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    let val = n;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    const s = val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : Math.round(val).toString();
    return `${parseFloat(s)} ${units[i]}`;
  }
  function fmtInt(n) {
    if (n == null || !Number.isFinite(n)) return null;
    if (Math.abs(n - Math.round(n)) < 1e-9) return Math.round(n).toLocaleString();
    return Number(n.toFixed(4)).toString();
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
  // `input` is id -> number|null in canonical units. `recency` is id -> how recently the user set it (-1 for
  // empty or derived). A rule may overwrite a field only when one of its inputs is more recent than the field,
  // and `activeId` (the field being typed in) is never overwritten. Returns the solved values and, for each
  // field a rule filled in, the rule that did it (in the order they fired).
  function solve(input, recency, activeId = null) {
    const v = {};
    const rec = {};
    for (const id of FIELD_IDS) {
      v[id] = input[id] ?? null;
      rec[id] = recency[id] ?? -1;
    }
    const derivation = new Map();
    let order = 0;

    let changed = true;
    let iter = 0;
    while (changed && iter < 30) {
      changed = false;
      iter++;
      for (const rule of RULES) {
        // every input must have a value
        if (!rule.inputs.every((i) => v[i] != null)) continue;
        const result = rule.compute(v);
        if (result == null || !Number.isFinite(result) || result < 0) continue;

        const inputRecency = Math.max(...rule.inputs.map((i) => rec[i]));
        const targetRecency = rec[rule.target];
        const cur = v[rule.target];

        if (cur == null) {
          v[rule.target] = result;
          rec[rule.target] = Math.max(inputRecency, 0);
          derivation.delete(rule.target);
          derivation.set(rule.target, { rule, order: order++ });
          changed = true;
        } else if (Math.abs(cur - result) > 1e-9) {
          // Only overwrite if target is older than at least one input. The active field is never overwritten.
          if (rule.target !== activeId && targetRecency < inputRecency) {
            v[rule.target] = result;
            rec[rule.target] = inputRecency;
            derivation.delete(rule.target);
            derivation.set(rule.target, { rule, order: order++ });
            changed = true;
          }
        }
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

  // ───────────────────────────── explanation ───────────────────────────────
  function givenStep(given) {
    const parts = FIELD_IDS.filter((id) => given[id] != null).map((id) => (
      BYTE_FIELDS.has(id)
        ? `${LABELS[id]} = ${fmtBytes(given[id])} (${num(given[id])} bytes)`
        : `${LABELS[id]} = ${num(given[id])}`
    ));
    return parts.length ? [`Given: ${parts.join(', ')}.`] : [];
  }

  // In the order the rules fired, which is always a valid order to read them in. The memory sizes go last:
  // nothing else is worked out from them, so a reader meets index and tag bits before "2^32 bytes".
  function ruleSteps(v, derivation) {
    const late = (target) => (target === 'addressable_memory' || target === 'virtual_memory' ? 1 : 0);
    return [...derivation.entries()]
      .sort((a, b) => late(a[0]) - late(b[0]) || a[1].order - b[1].order)
      .map(([target, { rule }]) => (
        `${cap(LABELS[target])} = ${rule.formula} = ${rule.show(v)} = ${num(v[target])}${BYTE_FIELDS.has(target) ? ' bytes' : ''}.`
      ));
  }

  function extraSteps(v, e) {
    const out = [];
    const add = (key, formula, shown, unit = '') => {
      if (e[key] != null && Number.isFinite(e[key])) {
        out.push(`${cap(EXTRA_LABELS[key])} = ${formula} = ${shown} = ${num(e[key])}${unit}.`);
      }
    };
    if (e.num_tags != null) out.push(`Number of tags = number of blocks (one tag per block) = ${num(e.num_tags)}.`);
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

  // Inputs that cannot all be true at once: a relation whose result differs from a value already there.
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

  // Everything the API reports for a set of known values (id -> number, canonical units). All of them count as
  // given with equal weight, so values that disagree are reported rather than one silently winning.
  function analyze(given) {
    const start = {};
    const recency = {};
    for (const id of FIELD_IDS) {
      start[id] = given[id] ?? null;
      recency[id] = start[id] != null ? 1 : -1;
    }
    const { values, derivation } = solve(start, recency, null);
    const extras = deriveExtras(values);
    return {
      values,
      extras,
      rows: resultRows(values, extras),
      steps: [...givenStep(start), ...ruleSteps(values, derivation), ...extraSteps(values, extras)],
      conflicts: findConflicts(values),
      warnings: findWarnings(values, extras),
      notDetermined: notDetermined(start, values, extras),
    };
  }

  globalThis.CacheCruncherSolver = Object.freeze({
    UNITS, FIELDS, FIELD_IDS, BYTE_FIELDS, LABELS, EXTRA_LABELS, NEEDS,
    isPow2, ilog2, fmtBytes, fmtInt, num,
    solve, deriveExtras, resultRows, analyze,
  });
})();
