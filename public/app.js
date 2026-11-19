// Cache Cruncher: the page. The math (rules, working, simulator, link parsing) is /solver.js, loaded before
// this file and shared with the JSON API. This file is the form, the pictures and the simulator's controls.
//
// Every input is 'empty', 'user' (the visitor typed it) or 'auto' (worked out). Each edit gets a rising stamp.
// Everything shown is derived from the typed values only, newest edit first: when two typed values cannot both
// be true the more recent one wins, and the older one is replaced once the visitor leaves the box they are in.

(() => {
  const Solver = globalThis.CacheCruncherSolver;
  if (!Solver) {
    console.error('Cache Cruncher: /solver.js did not load, so the calculator cannot start.');
    return;
  }
  const { UNITS, FIELDS, FIELD_IDS, LABELS, EXTRA_LABELS } = Solver;

  const SESSION_VOTED_KEY = 'cachecruncher-feedback-voted';
  const FEEDBACK_TOTALS_CACHE_KEY = 'cachecruncher-feedback-totals';
  const SERVER_FEEDBACK_URL = '/api/feedback';
  const FEEDBACK_TYPES = [
    { id: 'love', emoji: '❤️‍🔥', label: 'Flaming heart' },
    { id: 'death', emoji: '💀', label: 'Death' },
  ];
  const feedbackCounts = Object.fromEntries(FEEDBACK_TYPES.map(({ id }) => [id, 0]));
  let feedbackTotal = 0;

  // A cache this small is drawn whole; a bigger one shows only the sets that have been touched.
  const TABLE_ROWS_SHOWN_WHOLE = 256;

  // ─────────────────────────────── state ───────────────────────────────────
  const state = {};      // id -> 'empty' | 'user' | 'auto'
  const editedAt = {};   // id -> recency stamp of the visitor's last edit
  const unitOf = {};     // unit selector id -> the unit its number is currently shown in
  const unitPicked = {}; // unit selector id -> true once the visitor chose the unit themselves
  const unitDefault = {}; // unit selector id -> the unit the page starts with
  let recencyCounter = 0;
  let activeId = null;   // the input being typed in (never rewritten under the cursor)
  let commitPending = false; // a box was left: typed values that lost to newer ones now give way
  let adjustments = [];  // what that changed, shown until the next edit
  let linkProblem = '';  // why a link's values could not be read
  let lastQuery = null;

  const sim = { key: '', core: null, trace: [], message: '' };

  for (const id of FIELD_IDS) {
    state[id] = 'empty';
    editedAt[id] = 0;
  }

  // ─────────────────────────────── helpers ─────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function scrollActiveRowIntoView(container) {
    if (!container) return;
    const row = container.querySelector('tr.active-row');
    if (!row) return;
    requestAnimationFrame(() => {
      const pageX = window.scrollX;
      const pageY = window.scrollY;
      const centeredTop = row.offsetTop - Math.max(0, (container.clientHeight - row.offsetHeight) / 2);
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(maxTop, Math.max(0, centeredTop));
      window.scrollTo(pageX, pageY);
    });
  }

  function readField(id) {
    const f = FIELDS[id];
    const raw = $(id).value.trim();
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return f.kind === 'size' ? n * UNITS[$(f.unitId).value] : n;
  }

  function writeField(id, canonical) {
    if (id === activeId) return false; // never overwrite focused input
    const f = FIELDS[id];
    const input = $(id);
    let display;
    if (canonical === null || canonical === undefined || !Number.isFinite(canonical)) {
      display = '';
    } else if (f.kind === 'size') {
      // A worked-out size is shown in the unit that reads best (4 GB, not 4194304 KB) unless the visitor chose one.
      if (!unitPicked[f.unitId]) setUnit(f.unitId, Solver.splitSize(canonical).unit);
      display = formatNum(canonical / UNITS[$(f.unitId).value]);
    } else {
      display = formatNum(canonical);
    }
    state[id] = display === '' ? 'empty' : 'auto';
    input.classList.toggle('auto-filled', state[id] === 'auto');
    if (input.value === display) return false;
    input.value = display;
    return true;
  }

  function formatNum(n) {
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return Number(n.toFixed(6)).toString();
  }

  function setUnit(unitId, unit) {
    $(unitId).value = unit;
    unitOf[unitId] = unit;
  }

  function formatFeedbackSummary() {
    return `${feedbackTotal} interactions · ${FEEDBACK_TYPES.map(({ id, emoji }) => `${emoji} ${feedbackCounts[id]}`).join(' · ')}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function toHex(value) {
    return `0x${Math.max(0, value).toString(16).toUpperCase()}`;
  }

  // What the visitor typed (in canonical units), and which of it is newest.
  function typedValues() {
    const typed = {};
    for (const id of FIELD_IDS) {
      if (state[id] !== 'user') continue;
      const value = readField(id);
      if (value != null) typed[id] = value;
    }
    const newestFirst = Object.keys(typed).sort((a, b) => editedAt[b] - editedAt[a]);
    return { typed, newestFirst };
  }
  const settleNow = () => {
    const { typed, newestFirst } = typedValues();
    return Solver.settle(typed, newestFirst);
  };

  // ───────────────────────────── feedback ──────────────────────────────────
  function updateFeedbackUI() {
    const summary = document.getElementById('feedbackSummary');
    if (!summary) return;
    const voted = Boolean(sessionStorage.getItem(SESSION_VOTED_KEY));
    const voteText = voted ? 'Thank you for voting this session.' : 'You can vote once per session.';
    summary.textContent = `${voteText} Total: ${formatFeedbackSummary()}`;
  }

  function saveFeedbackTotalsToCache() {
    try {
      localStorage.setItem(FEEDBACK_TOTALS_CACHE_KEY, JSON.stringify({
        ...feedbackCounts,
        total: feedbackTotal,
      }));
    } catch {
      // ignore localStorage errors in private mode or restricted contexts
    }
  }

  function loadFeedbackTotalsFromCache() {
    try {
      const raw = localStorage.getItem(FEEDBACK_TOTALS_CACHE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      let applied = false;
      for (const { id } of FEEDBACK_TYPES) {
        const n = Number(data?.[id]);
        if (Number.isFinite(n) && n >= 0) {
          feedbackCounts[id] = n;
          applied = true;
        }
      }
      const total = Number(data?.total);
      if (Number.isFinite(total) && total >= 0) {
        feedbackTotal = total;
        applied = true;
      } else {
        feedbackTotal = FEEDBACK_TYPES.reduce((sum, { id }) => sum + feedbackCounts[id], 0);
      }
      return applied;
    } catch {
      return false;
    }
  }

  function disableFeedbackButtons() {
    document.querySelectorAll('.feedback-btn').forEach((button) => {
      button.disabled = true;
      button.classList.add('disabled');
    });
  }

  async function fetchFeedbackTotals() {
    try {
      const url = new URL(SERVER_FEEDBACK_URL, window.location.origin);
      url.searchParams.set('t', String(Date.now()));
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load counts');
      const data = await res.json();
      for (const { id } of FEEDBACK_TYPES) {
        const n = Number(data?.[id]);
        feedbackCounts[id] = Number.isFinite(n) && n >= 0 ? n : 0;
      }
      const total = Number(data?.total);
      feedbackTotal = Number.isFinite(total) && total >= 0
        ? total
        : FEEDBACK_TYPES.reduce((sum, { id }) => sum + feedbackCounts[id], 0);
      saveFeedbackTotalsToCache();
    } catch {
      // Fallback to last known totals so counts survive browser sessions.
      if (!loadFeedbackTotalsFromCache()) {
        feedbackTotal = FEEDBACK_TYPES.reduce((sum, { id }) => sum + feedbackCounts[id], 0);
      }
    }
    updateFeedbackUI();
  }

  async function submitFeedback(id) {
    if (!FEEDBACK_TYPES.some((type) => type.id === id)) return;
    if (sessionStorage.getItem(SESSION_VOTED_KEY)) return;

    try {
      const res = await fetch(SERVER_FEEDBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: id }),
      });
      if (!res.ok) throw new Error('Failed to submit vote');
      const data = await res.json();
      for (const { id: typeId } of FEEDBACK_TYPES) {
        const n = Number(data?.[typeId]);
        feedbackCounts[typeId] = Number.isFinite(n) && n >= 0 ? n : feedbackCounts[typeId];
      }
      const total = Number(data?.total);
      feedbackTotal = Number.isFinite(total) && total >= 0
        ? total
        : FEEDBACK_TYPES.reduce((sum, { id: typeId }) => sum + feedbackCounts[typeId], 0);
      saveFeedbackTotalsToCache();
      sessionStorage.setItem(SESSION_VOTED_KEY, id);
      disableFeedbackButtons();
    } catch {
      // ignore submit failure; user can try again later
    }
    updateFeedbackUI();
  }

  function incrementFeedback(id) {
    submitFeedback(id);
  }

  // ───────────────────────────── results ───────────────────────────────────
  function paint(dlId, rows) {
    const dl = $(dlId);
    const prev = dl._prev || {};
    const next = {};
    const html = [];
    for (const [label, value] of rows) {
      const v = value == null ? '—' : value;
      next[label] = v;
      const fresh = prev[label] !== undefined && prev[label] !== v ? ' fresh' : '';
      const emptyCls = value == null ? ' empty' : '';
      html.push(`<dt>${label}</dt><dd class="${emptyCls.trim()}${fresh}">${v}</dd>`);
    }
    dl.innerHTML = html.join('');
    dl._prev = next;
  }

  // How an address splits up, as a bar whose pieces are as wide as their share of the bits.
  const PART_CLASS = {
    'Tag': 'part-tag', 'Index': 'part-index', 'Offset': 'part-offset',
    'Virtual page number': 'part-tag', 'Page offset': 'part-offset',
    'TLB tag': 'part-tag', 'TLB index': 'part-index',
  };
  function layoutBar(title, parts) {
    const total = parts.reduce((sum, part) => sum + part.bits, 0);
    const wrap = make('div', 'layout');
    const head = make('p', 'layout-title');
    head.append(make('strong', null, title), make('span', null, ` · ${total} bits`));
    const bar = make('div', 'layout-bar');
    bar.tabIndex = 0;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', `${title}, ${total} bits`);
    for (const part of parts) {
      const cell = make('div', `layout-part ${PART_CLASS[part.name] || ''}${part.bits === 0 ? ' zero' : ''}`);
      cell.style.flexGrow = String(Math.max(part.bits, 1));
      const range = part.bits === 0 ? 'not used' : part.high === part.low ? `bit ${part.high}` : `bits ${part.high}–${part.low}`;
      cell.append(
        make('strong', null, part.name),
        make('span', 'layout-bits', `${part.bits} ${part.bits === 1 ? 'bit' : 'bits'}`),
        make('span', 'layout-range', range),
      );
      bar.append(cell);
    }
    wrap.append(head, bar);
    return wrap;
  }
  function renderLayouts(layouts) {
    const box = $('addressLayouts');
    const bars = [];
    if (layouts.cache) bars.push(layoutBar('Physical address, as the cache reads it', layouts.cache));
    if (layouts.virtual) bars.push(layoutBar('Virtual address, as the page table reads it', layouts.virtual));
    if (layouts.tlb) bars.push(layoutBar('Virtual address, as the TLB reads it', layouts.tlb));
    if (!bars.length) {
      box.className = 'layouts empty-state';
      box.textContent = 'Enter a cache and an address size to see how an address splits into tag, index and offset.';
      return;
    }
    box.className = 'layouts';
    box.replaceChildren(...bars);
  }

  // Anything the visitor should look at: a value that was replaced, or numbers that are not a real cache.
  function renderNotes(result) {
    const box = $('notes');
    const items = [];
    if (linkProblem) items.push(['warn', `This link's values could not be read: ${linkProblem}`]);
    for (const text of adjustments) items.push(['changed', `Updated to match your newer values. ${text}`]);
    for (const [id, entry] of Object.entries(result.overridden)) {
      if (state[id] === 'user') items.push(['pending', `${entry.text} It will be replaced when you leave the box you are typing in.`]);
    }
    for (const text of result.conflicts) items.push(['warn', text]);
    for (const text of result.warnings) items.push(['warn', text]);
    if (!items.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const list = make('ul', 'notes-list');
    for (const [kind, text] of items) list.append(make('li', `note note-${kind}`, text));
    box.hidden = false;
    box.replaceChildren(make('h2', 'notes-title', 'Check these'), list);
  }

  // The working: each value, the formula behind it and the numbers that went in.
  function fieldNames(text) {
    return text.replace(/[a-z_]+/g, (word) => (Object.hasOwn(LABELS, word) ? LABELS[word] : word));
  }
  function renderWorking(result) {
    const box = $('workingSteps');
    if (!result.steps.length) {
      box.className = 'working empty-state';
      box.textContent = 'Enter some values, or try an example above, to see the working.';
      return;
    }
    const nodes = [];
    const list = make('ol', 'working-list');
    for (const step of result.steps) {
      if (step.given) {
        const given = make('p', 'working-given');
        given.append(make('strong', null, 'Given: '));
        step.given.forEach((item, index) => {
          given.append(`${index ? ', ' : ''}${item.label} = `, make('span', 'working-value', item.value));
        });
        nodes.push(given);
        continue;
      }
      const li = make('li');
      li.append(make('strong', null, step.label), make('span', 'working-eq', ` = ${step.formula}${step.work ? ` = ${step.work}` : ''} = `), make('span', 'working-value', step.result));
      list.append(li);
    }
    if (list.children.length) nodes.push(list);
    const missing = Object.entries(result.notDetermined);
    if (missing.length) {
      const unknown = make('p', 'working-missing');
      unknown.append(make('strong', null, 'Not worked out yet: '));
      missing.forEach(([id, needs], index) => {
        unknown.append(`${index ? '; ' : ''}${LABELS[id] || EXTRA_LABELS[id]} (needs ${fieldNames(needs)})`);
      });
      nodes.push(unknown);
    }
    box.className = 'working';
    box.replaceChildren(...nodes);
  }

  // ───────────────────────────── simulator ─────────────────────────────────
  function simPolicy() {
    return $('simPolicy').value;
  }

  function ensureSimulator(config) {
    const key = Solver.simKey(config, simPolicy());
    if (sim.key === key && sim.core) return;
    sim.key = key;
    sim.core = Solver.simCreate(config, simPolicy());
    sim.trace = [];
    sim.message = '';
  }

  function resetSimulator() {
    sim.key = '';
    sim.core = null;
    sim.trace = [];
    sim.message = '';
  }

  // Why there is no simulator yet, in the visitor's terms.
  function simulatorBlocker(v) {
    if (v.block_size == null || v.num_sets == null || v.associativity == null) {
      return 'Enter a cache (for example its size, block size and associativity) to unlock the Cache Simulator.';
    }
    if (v.address_size == null) return 'Add the physical address size (bits) to unlock the Cache Simulator.';
    if (!Solver.isPow2(v.block_size) || !Solver.isPow2(v.num_sets)) {
      return 'The Cache Simulator needs a block size and a number of sets that are powers of two.';
    }
    if (v.address_size > 53) return 'The Cache Simulator steps through addresses of up to 53 bits.';
    return 'These values do not describe a cache the simulator can run. Check the notes above.';
  }

  function renderTranslation(access, config) {
    const el = $('simTranslation');
    if (!access || !config) {
      el.className = 'bit-breakdown empty-state';
      el.textContent = 'No address translation yet.';
      return;
    }

    const cells = access.mode === 'virtual'
      ? [
          ['Operation', access.operation.toUpperCase()],
          ['Virtual', toHex(access.virtualAddress)],
          ['VPN', String(access.vpn)],
          ['Page Offset', String(access.pageOffset)],
          ['Physical Frame', String(access.physicalPage)],
          ['Physical', toHex(access.address)],
          ['TLB', access.tlbIndex != null && access.tlbTag != null ? `${access.tlbHit ? 'hit' : 'miss'} · index ${access.tlbIndex} · tag ${access.tlbTag}` : 'Not configured'],
        ]
      : [
          ['Operation', access.operation.toUpperCase()],
          ['Physical', toHex(access.address)],
          ['Block', String(access.blockNumber)],
          ['Set', String(access.setIndex)],
          ['Offset', String(access.offset)],
        ];

    el.className = 'bit-breakdown translation-grid';
    el.innerHTML = cells.map(([label, value]) => `<div class="bit-cell"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
    if (access.mode === 'virtual') {
      el.innerHTML += `<div class="translation-note">${escapeHtml(`Stand-in page table: virtual page n maps to physical page n mod ${config.physicalPages}, after a direct-mapped TLB lookup.`)}</div>`;
    }
  }

  function renderBreakdown(access, config) {
    const el = $('simBreakdown');
    if (!access || !config) {
      el.className = 'bit-breakdown empty-state';
      el.textContent = 'No access yet.';
      return;
    }
    const binary = access.address.toString(2).padStart(config.addressSize, '0');
    const tagBits = binary.slice(0, config.tagBits) || '—';
    const indexBits = binary.slice(config.tagBits, config.tagBits + config.indexBits) || '—';
    const offsetBits = binary.slice(config.tagBits + config.indexBits) || '—';
    el.className = 'bit-breakdown';
    el.innerHTML = [
      ['Op', access.operation.toUpperCase(), ''],
      ['Tag', tagBits, 'part-tag'],
      ['Index', indexBits, 'part-index'],
      ['Offset', offsetBits, 'part-offset'],
      ['Result', `${access.outcome} in set ${access.setIndex}, way ${access.way}`, ''],
      ['Dirty', access.dirty ? '1' : '0', ''],
    ].map(([label, value, part]) => `<div class="bit-cell ${part}"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  function renderAddressChain(access, config) {
    const el = $('simChain');
    if (!access || !config) {
      el.className = 'address-chain empty-state';
      el.textContent = 'No access yet.';
      return;
    }

    const isVirtual = access.mode === 'virtual';
    const blockBase = access.blockNumber * config.blockSize;
    const steps = isVirtual
      ? [
          ['Virtual address', toHex(access.virtualAddress)],
          ['VPN', String(access.vpn)],
          ['TLB', access.tlbIndex != null ? `${access.tlbHit ? 'hit' : 'miss'} · row ${access.tlbIndex}` : 'not used'],
          ['PPN', String(access.physicalPage)],
          ['Physical address', toHex(access.address)],
        ]
      : [
          ['Physical address', toHex(access.address)],
          ['Block', String(access.blockNumber)],
          ['Set', String(access.setIndex)],
        ];

    steps.push(
      ['Cache line', `set ${access.setIndex} · way ${access.way} · ${access.outcome}`],
      ['Memory block', `${access.blockNumber} · base ${toHex(blockBase)} · ${toHex(blockBase + config.blockSize - 1)}`],
    );

    el.className = 'address-chain';
    el.innerHTML = steps.map(([label, value]) => `<div class="chain-step"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  // Every access so far, oldest first: the table a homework question asks for.
  function renderTrace() {
    const el = $('simTrace');
    if (!sim.trace.length) {
      el.className = 'table-shell trace-shell empty-state';
      el.textContent = 'No addresses accessed yet.';
      return;
    }
    const virtual = sim.trace.some((access) => access.mode === 'virtual');
    const rows = sim.trace.map((access, index) => {
      const address = access.mode === 'virtual' ? `${toHex(access.virtualAddress)} → ${toHex(access.address)}` : toHex(access.address);
      const replaced = access.evicted
        ? `block ${access.evicted.blockNumber} (tag ${toHex(access.evicted.tag)})${access.evicted.dirty ? ', written back' : ''}`
        : '—';
      const tlb = access.tlbHit == null ? '—' : (access.tlbHit ? 'hit' : 'miss');
      return `
        <tr class="${index === sim.trace.length - 1 ? 'active-row' : ''}">
          <td>${access.number}</td>
          <td>${access.operation === 'write' ? 'W' : 'R'}</td>
          <td>${escapeHtml(address)}</td>
          ${virtual ? `<td>${tlb}</td>` : ''}
          <td>${escapeHtml(toHex(access.tag))}</td>
          <td>${access.setIndex}</td>
          <td>${access.offset}</td>
          <td><span class="outcome ${access.outcome.toLowerCase()}">${access.outcome}</span></td>
          <td>${escapeHtml(replaced)}</td>
        </tr>
      `;
    }).join('');
    const headers = ['#', 'Op', 'Address', ...(virtual ? ['TLB'] : []), 'Tag', 'Set', 'Offset', 'Result', 'Replaced'];
    el.className = 'table-shell trace-shell';
    el.innerHTML = `<table class="sim-table trace-table"><thead><tr>${headers.map((header) => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
    el.scrollTop = el.scrollHeight;
  }

  function renderStats() {
    const el = $('simStats');
    const stats = sim.core ? sim.core.stats : null;
    if (!stats || !stats.accesses) {
      el.textContent = '';
      return;
    }
    const rate = (100 * stats.hits) / stats.accesses;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : (word.endsWith('s') ? 'es' : 's')}`;
    const parts = [
      plural(stats.accesses, 'access'),
      plural(stats.hits, 'hit'),
      plural(stats.misses, 'miss'),
      `hit rate ${Number(rate.toFixed(1))}%`,
      plural(stats.replacements, 'replacement'),
    ];
    if (stats.writeBacks) parts.push(plural(stats.writeBacks, 'write-back'));
    if (stats.tlbHits + stats.tlbMisses) parts.push(`TLB ${plural(stats.tlbHits, 'hit')}, ${plural(stats.tlbMisses, 'miss')}`);
    el.textContent = parts.join(' · ');
  }

  function renderAssumptions(config) {
    const victim = simPolicy() === 'fifo' ? 'the block that was loaded longest ago (FIFO)' : 'the least recently used block (LRU)';
    const virtual = config && Solver.simSupportsVirtual(config)
      ? ' The TLB is direct-mapped, and the page table is a stand-in that never page-faults.'
      : '';
    $('simAssumptions').textContent = `Addresses are byte addresses. On a miss an empty way is filled first; after that ${victim} is replaced.${virtual}`;
  }

  function renderTlbTable(config) {
    const el = $('simTlbTable');
    if (!config || !Solver.simSupportsVirtual(config) || $('simAddressType').value !== 'virtual') {
      el.className = 'table-shell empty-state';
      el.textContent = 'Switch to virtual mode to view TLB activity.';
      return;
    }
    if (!config.tlbRows) {
      el.className = 'table-shell empty-state';
      el.textContent = 'Enter the number of TLB rows (a power of two) to see the TLB.';
      return;
    }
    const whole = config.tlbRows <= TABLE_ROWS_SHOWN_WHOLE;
    const indexes = whole
      ? Array.from({ length: config.tlbRows }, (_, index) => index)
      : [...sim.core.tlb.keys()].sort((a, b) => a - b);
    const rows = indexes.map((index) => {
      const entry = sim.core.tlb.get(index);
      const current = sim.core.last && sim.core.last.tlbIndex === index;
      return `
        <tr class="${current ? 'active-row' : ''}">
          <td>${index}</td>
          <td>${entry ? '1' : '0'}</td>
          <td>${entry ? escapeHtml(toHex(entry.tag)) : '—'}</td>
          <td>${entry ? entry.vpn : '—'}</td>
          <td>${entry ? entry.physicalPage : '—'}</td>
        </tr>
      `;
    }).join('');
    el.className = 'table-shell';
    el.innerHTML = `<table class="sim-table"><thead><tr><th scope="col">Row</th><th scope="col">V</th><th scope="col">TLB Tag</th><th scope="col">VPN</th><th scope="col">PPN</th></tr></thead><tbody>${rows}</tbody></table>${whole ? '' : `<p class="table-note">Showing the ${indexes.length} rows used so far, of ${config.tlbRows}.</p>`}`;
    scrollActiveRowIntoView(el);
  }

  function renderPageTable(config) {
    const el = $('simPageTable');
    if (!config || !Solver.simSupportsVirtual(config) || $('simAddressType').value !== 'virtual') {
      el.className = 'table-shell empty-state';
      el.textContent = 'Switch to virtual mode to view page table mappings.';
      return;
    }
    const last = sim.core.last;
    if (!last || last.vpn == null) {
      el.className = 'table-shell empty-state';
      el.textContent = 'Page table rows will appear here.';
      return;
    }
    const currentVpn = last.vpn;
    const maxVpn = Math.max(0, (2 ** config.vpnBits) - 1);
    const startVpn = Math.max(0, currentVpn - 2);
    const endVpn = Math.min(maxVpn, currentVpn + 2);
    const rows = [];
    for (let vpn = startVpn; vpn <= endVpn; vpn += 1) {
      const physicalPage = vpn % config.physicalPages;
      rows.push(`
        <tr class="${vpn === currentVpn ? 'active-row' : ''}">
          <td>${vpn}</td>
          <td>${physicalPage}</td>
          <td>${escapeHtml(toHex(physicalPage * config.pageSize))}</td>
          <td>${vpn === currentVpn ? 'Current VPN' : 'Mapped VPN'}</td>
        </tr>
      `);
    }
    el.className = 'table-shell';
    el.innerHTML = `<table class="sim-table"><thead><tr><th scope="col">VPN</th><th scope="col">PPN</th><th scope="col">Base</th><th scope="col">Status</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function renderCacheTable(config) {
    const el = $('simCacheTable');
    if (!config) {
      el.className = 'table-shell empty-state';
      el.textContent = 'Cache table will appear here.';
      return;
    }
    const last = sim.core.last;
    const whole = config.numBlocks <= TABLE_ROWS_SHOWN_WHOLE;
    const setIndexes = whole
      ? Array.from({ length: config.numSets }, (_, index) => index)
      : [...sim.core.sets.keys()].sort((a, b) => a - b);
    if (!setIndexes.length) {
      el.className = 'table-shell empty-state';
      el.textContent = `${config.numSets} sets of ${config.associativity}. Each set appears here once an address lands in it.`;
      return;
    }
    const emptyWays = Array.from({ length: config.associativity }, (_, way) => ({ way, valid: false }));
    const rows = [];
    for (const setIndex of setIndexes) {
      for (const line of (sim.core.sets.get(setIndex) || emptyWays)) {
        const current = last && last.setIndex === setIndex && last.way === line.way;
        const stateLabel = line.valid ? (current ? 'Active' : (line.dirty ? 'Dirty' : 'Loaded')) : 'Empty';
        const mapping = line.valid
          ? `<div class="mapping-cell">
              <strong>${escapeHtml(toHex(line.tag))}</strong>
              <span>tag</span>
              <div class="mapping-meta">block ${line.blockNumber} · base ${escapeHtml(toHex(line.baseAddress))} · dirty ${line.dirty ? '1' : '0'}</div>
            </div>`
          : '<div class="mapping-empty">No block loaded yet</div>';
        rows.push(`
          <tr class="${current ? 'active-row' : ''}">
            <td>${setIndex}</td>
            <td>${line.way}</td>
            <td><span class="state-badge ${stateLabel.toLowerCase()}">${stateLabel}</span></td>
            <td>${mapping}</td>
          </tr>
        `);
      }
    }
    el.className = 'table-shell';
    el.innerHTML = `<table class="sim-table"><thead><tr>${['Set', 'Way', 'State', 'Mapping'].map((header) => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>${whole ? '' : `<p class="table-note">Showing the ${setIndexes.length} sets used so far, of ${config.numSets}.</p>`}`;
    scrollActiveRowIntoView(el);
  }

  function renderMemoryTable(config) {
    const el = $('simMemoryTable');
    const last = sim.core ? sim.core.last : null;
    if (!config || !last) {
      el.className = 'table-shell empty-state';
      el.textContent = 'Memory blocks will appear here.';
      return;
    }
    const currentBlock = last.blockNumber;
    const maxBlocks = Math.max(1, Math.floor(config.memoryBytes / config.blockSize));
    const startBlock = Math.max(0, currentBlock - 2);
    const endBlock = Math.min(maxBlocks - 1, currentBlock + 2);
    const rows = [];
    for (let block = startBlock; block <= endBlock; block += 1) {
      const base = block * config.blockSize;
      const bytes = Array.from({ length: Math.min(config.blockSize, 8) }, (_, index) => toHex(base + index)).join(', ');
      rows.push(`
        <tr class="${block === currentBlock ? 'active-row' : ''}">
          <td>${block}</td>
          <td>${escapeHtml(toHex(base))}</td>
          <td>${escapeHtml(toHex(base + config.blockSize - 1))}</td>
          <td>${escapeHtml(bytes)}${config.blockSize > 8 ? ', …' : ''}</td>
        </tr>
      `);
    }
    el.className = 'table-shell';
    el.innerHTML = `<table class="sim-table"><thead><tr><th scope="col">Block</th><th scope="col">Start</th><th scope="col">End</th><th scope="col">Bytes</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  // A table that scrolls must be reachable from the keyboard, and say what it is.
  const SCROLL_REGIONS = {
    simTrace: 'Trace of accesses',
    simCacheTable: 'Cache table',
    simTlbTable: 'TLB table',
    simPageTable: 'Page table',
    simMemoryTable: 'Memory blocks',
  };
  function labelScrollRegions() {
    for (const [id, label] of Object.entries(SCROLL_REGIONS)) {
      const el = $(id);
      if (el.querySelector('table')) {
        el.tabIndex = 0;
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', label);
      } else {
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
      }
    }
  }

  function renderSimulator(v) {
    const config = Solver.simConfig(v);
    const status = $('simStatus');
    const controls = ['simAddBtn', 'simRandomBtn', 'simResetBtn', 'simRunBtn', 'simAddress', 'simList'].map($);

    if (!config) {
      resetSimulator();
      status.textContent = simulatorBlocker(v);
      status.className = 'simulator-status';
      for (const control of controls) control.disabled = true;
      renderBreakdown(null, null);
      renderTranslation(null, null);
      renderAddressChain(null, null);
      renderTrace();
      renderStats();
      renderAssumptions(null);
      renderTlbTable(null);
      renderPageTable(null);
      renderCacheTable(null);
      renderMemoryTable(null);
      labelScrollRegions();
      return;
    }

    const modeEl = $('simAddressType');
    const virtualSupported = Solver.simSupportsVirtual(config);
    modeEl.querySelector('option[value="virtual"]').disabled = !virtualSupported;
    if (!virtualSupported && modeEl.value === 'virtual') {
      modeEl.value = 'physical';
    }
    const mode = modeEl.value;

    ensureSimulator(config);
    const last = sim.core.last;
    if (sim.message) {
      status.textContent = sim.message;
      status.className = `simulator-status ready${last ? ` ${last.outcome.toLowerCase()}` : ''}`;
    } else {
      status.textContent = `${config.associativity}-way cache · ${config.numSets} ${config.numSets === 1 ? 'set' : 'sets'} · ${config.blockSize}-byte blocks${mode === 'virtual' ? ' · virtual translation on' : ''}`;
      status.className = 'simulator-status ready';
    }
    for (const control of controls) control.disabled = false;
    renderTranslation(last, config);
    renderBreakdown(last, config);
    renderAddressChain(last, config);
    renderTrace();
    renderStats();
    renderAssumptions(config);
    renderTlbTable(config);
    renderPageTable(config);
    renderCacheTable(config);
    renderMemoryTable(config);
    labelScrollRegions();
  }

  // One access through the running simulator; returns what happened.
  function stepSimulator(config, inputAddress, mode, operation) {
    ensureSimulator(config);
    const translation = mode === 'virtual' ? Solver.simTranslate(sim.core, inputAddress) : null;
    const access = Solver.simAccess(sim.core, translation ? translation.physicalAddress : inputAddress, operation, translation);
    sim.trace.push(access);
    if (sim.trace.length > Solver.TRACE_LIMIT) sim.trace.shift();
    return access;
  }

  function simulatorInputs() {
    const values = settleNow().values;
    const config = Solver.simConfig(values);
    const mode = $('simAddressType').value;
    return {
      values,
      config,
      mode,
      operation: $('simOperation').value,
      bitWidth: config ? (mode === 'virtual' ? config.virtualAddressSize : config.addressSize) : null,
    };
  }

  function handleSimulatorAccess() {
    const { values, config, mode, operation, bitWidth } = simulatorInputs();
    if (!config) return;
    ensureSimulator(config);
    const address = Solver.parseAddress($('simAddress').value, bitWidth);
    if (address == null) {
      sim.message = `Enter an address between 0 and ${toHex((2 ** bitWidth) - 1)}, in hex (0x3F), binary (0b111111) or decimal.`;
      renderSimulator(values);
      $('simStatus').className = 'simulator-status';
      return;
    }
    const access = stepSimulator(config, address, mode, operation);
    sim.message = `Last ${operation} ${mode === 'virtual' ? `${toHex(address)} → ${toHex(access.address)}` : toHex(address)} → ${access.outcome} in set ${access.setIndex}, way ${access.way}${access.dirty ? ' · dirty' : ''}.`;
    renderSimulator(values);
  }

  function handleRandomAccess() {
    const { config, bitWidth } = simulatorInputs();
    if (!config) return;
    $('simAddress').value = toHex(Math.floor(Math.random() * (2 ** bitWidth)));
    handleSimulatorAccess();
  }

  // A pasted list, always from an empty cache so the answer matches a worked exercise.
  function handleRunList() {
    const { values, config, mode, operation, bitWidth } = simulatorInputs();
    if (!config) return;
    const trace = Solver.parseTrace($('simList').value, bitWidth, operation);
    sim.key = '';
    ensureSimulator(config);
    if (!trace.accesses.length) {
      sim.message = trace.errors.length
        ? `None of those could be read as addresses of up to ${bitWidth} bits: ${trace.errors.join(', ')}.`
        : 'Paste or type some addresses first, separated by spaces, commas or new lines.';
      renderSimulator(values);
      $('simStatus').className = 'simulator-status';
      return;
    }
    for (const { address, operation: op } of trace.accesses) stepSimulator(config, address, mode, op);
    const { stats } = sim.core;
    const notes = [];
    if (trace.errors.length) notes.push(`skipped ${trace.errors.join(', ')}`);
    if (trace.truncated) notes.push(`stopped at ${Solver.TRACE_LIMIT} addresses`);
    sim.message = `Ran ${stats.accesses} ${stats.accesses === 1 ? 'access' : 'accesses'} from an empty cache: ${stats.hits} ${stats.hits === 1 ? 'hit' : 'hits'}, ${stats.misses} ${stats.misses === 1 ? 'miss' : 'misses'}${notes.length ? ` (${notes.join('; ')})` : ''}.`;
    renderSimulator(values);
  }

  function handleResetTrace() {
    const { values } = simulatorInputs();
    $('simAddress').value = '';
    sim.key = '';
    renderSimulator(values);
  }

  // ───────────────────────────── recompute ─────────────────────────────────
  // Once per frame, however many keys were pressed in it. A page that is not being painted (a background tab,
  // a browser driven by a program) gets no frames, so a short timer does the same job there.
  let pending = false;
  function recompute() {
    if (pending) return;
    pending = true;
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      pending = false;
      const result = settleNow();

      // A box was left: older typed values that lost to newer ones are replaced now, and become derived.
      if (commitPending) {
        commitPending = false;
        const replaced = Object.keys(result.overridden).filter((id) => id !== activeId && state[id] === 'user');
        if (replaced.length) {
          adjustments = replaced.map((id) => result.overridden[id].text);
          for (const id of replaced) state[id] = 'empty';
        }
      }

      for (const id of FIELD_IDS) {
        const input = $(id);
        const overridden = state[id] === 'user' && id in result.overridden;
        input.classList.toggle('overridden', overridden);
        if (id === activeId || state[id] === 'user') continue;
        writeField(id, result.values[id]);
      }

      paint('cacheResults', result.rows.cache);
      paint('memResults', result.rows.memory);
      renderLayouts(result.layouts);
      renderNotes(result);
      renderWorking(result);
      renderSimulator(result.values);
      syncLink(result.given);
    };
    requestAnimationFrame(run);
    window.setTimeout(run, 80);
  }

  // ───────────────────────────── links and examples ─────────────────────────
  // The address bar always carries the typed values, so the page can be bookmarked or shared as it stands.
  function linkFor(given) {
    const params = new URLSearchParams(window.location.search);
    for (const name of [...FIELD_IDS, ...Object.keys(Solver.UNIT_IDS)]) params.delete(name);
    const rest = params.toString();
    const query = [rest, Solver.toQuery(given)].filter(Boolean).join('&');
    return `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  }
  function syncLink(given) {
    const next = linkFor(given);
    if (next === lastQuery) return;
    lastQuery = next;
    try {
      window.history.replaceState(window.history.state, '', next);
    } catch {
      // a sandboxed frame may refuse; the Copy link button still works
    }
  }

  // Fill the form with known values (canonical units), as though the visitor had typed them in this order.
  function applyGiven(given) {
    resetFields();
    for (const id of FIELD_IDS) {
      const value = given[id];
      if (value == null) continue;
      const f = FIELDS[id];
      const input = $(id);
      if (f.kind === 'size') {
        const size = Solver.splitSize(value);
        setUnit(f.unitId, size.unit);
        input.value = formatNum(size.value);
      } else {
        input.value = formatNum(value);
      }
      state[id] = 'user';
      editedAt[id] = ++recencyCounter;
    }
    recompute();
  }

  function applyQuery(query) {
    const parsed = Solver.parseInputs(new URLSearchParams(query));
    if (parsed.error) {
      linkProblem = parsed.error;
      return false;
    }
    if (!Object.keys(parsed.given).length) return false;
    applyGiven(parsed.given);
    return true;
  }

  async function copyLink() {
    const button = $('copyLinkBtn');
    const url = new URL(linkFor(settleNow().given), window.location.href).href;
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      const holder = make('textarea');
      holder.value = url;
      holder.setAttribute('readonly', '');
      holder.className = 'offscreen';
      document.body.append(holder);
      holder.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      holder.remove();
    }
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    button.textContent = copied ? 'Link copied' : 'Copy it from the address bar';
    window.setTimeout(() => { button.textContent = label; }, 2200);
  }

  // ─────────────────────────────── wiring ──────────────────────────────────
  function resetFields() {
    activeId = null;
    recencyCounter = 0;
    commitPending = false;
    adjustments = [];
    linkProblem = '';
    for (const id of FIELD_IDS) {
      const input = $(id);
      input.value = '';
      input.classList.remove('auto-filled', 'overridden');
      state[id] = 'empty';
      editedAt[id] = 0;
      const unitId = FIELDS[id].unitId;
      if (unitId) {
        unitPicked[unitId] = false;
        if (unitDefault[unitId]) setUnit(unitId, unitDefault[unitId]);
      }
    }
    resetSimulator();
  }

  function clearAll() {
    resetFields();
    $('simAddress').value = '';
    $('simList').value = '';
    $('simAddressType').value = 'physical';
    $('simOperation').value = 'read';
    recompute();
  }

  // The sticky bars' height, so a jump to a section does not land underneath them.
  function measureBars() {
    const top = document.querySelector('.topbar');
    const nav = document.querySelector('.section-nav');
    const topHeight = top ? top.getBoundingClientRect().height : 0;
    const navHeight = nav ? nav.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--topbar-h', `${Math.round(topHeight)}px`);
    document.documentElement.style.setProperty('--sticky-h', `${Math.round(topHeight + navHeight)}px`);
  }

  function watchSections() {
    const links = [...document.querySelectorAll('.section-nav a')];
    const targets = links.map((link) => document.getElementById(link.hash.slice(1))).filter(Boolean);
    if (!targets.length) return;
    let queued = false;
    const mark = () => {
      queued = false;
      const line = (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-h')) || 112) + 48;
      let current = targets[0];
      for (const target of targets) {
        if (target.getBoundingClientRect().top <= line) current = target;
      }
      for (const link of links) {
        if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    };
    window.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      window.setTimeout(mark, 60);
    }, { passive: true });
    mark();
  }

  function attach() {
    for (const id of FIELD_IDS) {
      const input = $(id);
      input.addEventListener('focus', () => { activeId = id; });
      input.addEventListener('blur', () => {
        if (activeId === id) activeId = null;
        commitPending = true;
        recompute();
      });
      input.addEventListener('input', (ev) => {
        if (!ev.isTrusted) return;
        const raw = input.value.trim();
        if (raw === '') {
          state[id] = 'empty';
          editedAt[id] = 0;
        } else {
          state[id] = 'user';
          editedAt[id] = ++recencyCounter;
        }
        input.classList.remove('auto-filled');
        adjustments = [];
        linkProblem = '';
        recompute();
      });
      // Unit selector changes: rewrite the displayed number in the new unit
      // without changing canonical bytes.
      const f = FIELDS[id];
      if (f.kind === 'size') {
        const unitEl = $(f.unitId);
        unitOf[f.unitId] = unitEl.value;
        unitDefault[f.unitId] = unitEl.value;
        unitEl.addEventListener('change', () => {
          const raw = input.value.trim();
          if (raw !== '') {
            const n = Number(raw);
            if (Number.isFinite(n)) {
              const canonical = n * UNITS[unitOf[f.unitId]];
              input.value = formatNum(canonical / UNITS[unitEl.value]);
            }
          }
          unitOf[f.unitId] = unitEl.value;
          unitPicked[f.unitId] = true;
          recompute();
        });
      }
    }

    $('clearBtn').addEventListener('click', clearAll);
    $('resetBtn').addEventListener('click', clearAll);
    $('copyLinkBtn').addEventListener('click', copyLink);
    for (const button of document.querySelectorAll('[data-example]')) {
      button.addEventListener('click', () => {
        applyQuery(button.dataset.example);
      });
    }

    $('simAddBtn').addEventListener('click', handleSimulatorAccess);
    $('simRandomBtn').addEventListener('click', handleRandomAccess);
    $('simResetBtn').addEventListener('click', handleResetTrace);
    $('simRunBtn').addEventListener('click', handleRunList);
    $('simPolicy').addEventListener('change', handleResetTrace);
    $('simAddressType').addEventListener('change', () => {
      $('simAddress').value = '';
      handleResetTrace();
    });
    $('simAddress').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSimulatorAccess();
      }
    });

    document.querySelectorAll('.feedback-btn').forEach((button) => {
      button.addEventListener('click', () => {
        incrementFeedback(button.dataset.feedback);
      });
    });

    if (sessionStorage.getItem(SESSION_VOTED_KEY)) {
      disableFeedbackButtons();
    }
    fetchFeedbackTotals();

    const themeBtn = $('themeToggle');
    const saved = localStorage.getItem('cc-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon();
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('cc-theme', next);
      updateThemeIcon();
    });

    function updateThemeIcon() {
      const t = document.documentElement.getAttribute('data-theme');
      themeBtn.textContent = t === 'dark' ? '☀️' : '🌙';
    }

    measureBars();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measureBars);
      for (const bar of document.querySelectorAll('.topbar, .section-nav')) observer.observe(bar);
    }
    watchSections();
  }

  document.addEventListener('DOMContentLoaded', () => {
    attach();
    if (!applyQuery(window.location.search)) recompute();
  });
})();

/* ww-mobile-header-runtime */
(function () {
  function start() {
    document.querySelectorAll('.site-header').forEach(function (header) {
      var button = header.querySelector('[data-ww-behavior~="nav-toggle"]');
      var id = button && button.getAttribute('aria-controls');
      var panel = id && document.getElementById(id);
      if (!panel || !header.contains(panel)) return;
      var row = button.parentElement;
      var navRoot = panel;
      while (navRoot.parentElement && navRoot.parentElement !== row && !navRoot.parentElement.matches('header,.site-header')) navRoot = navRoot.parentElement;
      if (navRoot.parentElement !== row) return;
      row.setAttribute('data-ww-mobile-header-row', '');
      navRoot.setAttribute('data-ww-mobile-nav-root', '');
      panel.setAttribute('data-ww-mobile-nav-panel', '');
      if (!panel.querySelector('[data-ww-mobile-language-links]')) {
        var links = Array.from(header.querySelectorAll('a.lang-switch,a.language-switch,.language-switcher a,.language-switch a,.lang-switcher a,.language-selector a,a[hreflang],[data-ww-language-switch] a,a[data-ww-language-switch]'));
        var seen = new Set();
        links = links.filter(function (link) {
          var href = link.getAttribute('href');
          if (!href || panel.contains(link) || seen.has(href) || Array.from(panel.querySelectorAll('a[href]')).some(function (own) { return own.getAttribute('href') === href; })) return false;
          try { if (!['http:', 'https:'].includes(new URL(href, location.href).protocol)) return false; } catch (_) { return false; }
          seen.add(href); return true;
        });
        if (links.length) {
          var group = document.createElement(panel.matches('ul,ol') ? 'li' : 'div');
          group.setAttribute('data-ww-mobile-language-links', '');
          links.forEach(function (link) {
            var mobile = document.createElement('a');
            mobile.href = link.getAttribute('href');
            mobile.textContent = link.textContent.trim() || link.getAttribute('aria-label') || link.getAttribute('hreflang') || 'Language';
            ['hreflang','lang','aria-label'].forEach(function (name) { if (link.hasAttribute(name)) mobile.setAttribute(name, link.getAttribute(name)); });
            mobile.className = 'nav-link ww-mobile-language-link';
            group.appendChild(mobile);
          });
          panel.appendChild(group);
        }
      }
      function update() {
        var style = getComputedStyle(button);
        var mobile = style.display !== 'none' && style.visibility !== 'hidden';
        header.toggleAttribute('data-ww-mobile-header', mobile);
      }
      update();
      var frame;
      window.addEventListener('resize', function () { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); }, { passive: true });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(header);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

/* ww-header-layout-runtime */
(function(){function start(){var header=document.querySelector('.site-header');if(!header)return;if(parseFloat(getComputedStyle(header).marginBlockEnd)<0)header.style.marginBlockEnd='0';function measure(){document.documentElement.style.setProperty('--ww-header-height',header.getBoundingClientRect().height+'px');}measure();if(typeof ResizeObserver!=='undefined')new ResizeObserver(measure).observe(header);}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();

/* ww-adaptive-header-runtime */
(function () {
  var MIN = 4.5, COLS = 24, ROWS = 8;
  function channel(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(r, g, b) { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
  function ratio(a, b) { return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
  function parse(value) {
    var m = /rgba?\(([^)]+)\)/.exec(value || ''); if (!m) return null;
    var p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  // Luminance of each cell of the strip of image that sits under the header.
  function imageSamples(backdrop, header) {
    var img = backdrop.querySelector('img');
    if (!img || !img.complete || !img.naturalWidth) return null;
    var box = backdrop.getBoundingClientRect(), bar = header.getBoundingClientRect();
    var top = Math.max(bar.top, box.top), bottom = Math.min(bar.bottom, box.bottom);
    if (bottom <= top || !box.width || !box.height) return null;
    var style = getComputedStyle(img), cover = style.objectFit === 'cover';
    var scale = Math.max(box.width / img.naturalWidth, box.height / img.naturalHeight);
    var y = parseFloat((style.objectPosition || '50% 50%').split(' ')[1]);
    var offset = (box.height - img.naturalHeight * scale) * ((isNaN(y) ? 50 : y) / 100);
    // Covered images are cropped around their focal point; any other fit stretches across the whole box.
    var sy = cover ? Math.max(0, (top - box.top - offset) / scale) : (top - box.top) / box.height * img.naturalHeight;
    var sh = Math.max(1, Math.min(img.naturalHeight - sy, cover ? (bottom - top) / scale : (bottom - top) / box.height * img.naturalHeight));
    var sx = cover ? Math.max(0, (img.naturalWidth - box.width / scale) / 2) : 0;
    var sw = cover ? Math.min(img.naturalWidth, box.width / scale) : img.naturalWidth;
    try {
      var canvas = document.createElement('canvas'); canvas.width = COLS; canvas.height = ROWS;
      var ctx = canvas.getContext('2d'); ctx.drawImage(img, sx, sy, sw, sh, 0, 0, COLS, ROWS);
      var data = ctx.getImageData(0, 0, COLS, ROWS).data, out = [];
      for (var i = 0; i < data.length; i += 4) out.push(lum(data[i], data[i + 1], data[i + 2]));
      return out;
    } catch (error) { return null; }
  }
  function colourSample(backdrop) {
    var c = parse(getComputedStyle(backdrop).backgroundColor);
    return c && c.a > 0.5 ? [lum(c.r, c.g, c.b)] : null;
  }
  // The weakest 5% of cells are ignored so one stray highlight does not decide the tone.
  function worst(samples, ink) {
    var all = samples.map(function (s) { return ratio(ink, s); }).sort(function (a, b) { return a - b; });
    return all[Math.floor(all.length * 0.05)];
  }
  function update(header) {
    var backdrop = document.querySelector('[data-ww-header-backdrop]');
    var samples = backdrop && (imageSamples(backdrop, header) || colourSample(backdrop));
    header.removeAttribute('data-ww-header-tone'); header.removeAttribute('data-ww-header-contrast');
    // A photo that cannot be read here (not loaded, or from another origin) is left to a scan of the deployed site.
    if (!samples) { if (backdrop) header.setAttribute('data-ww-header-tone', 'unverified'); return; }
    var probe = header.querySelector('.brand-title') || header, own = parse(getComputedStyle(probe).color);
    var light = worst(samples, 1), dark = own ? worst(samples, lum(own.r, own.g, own.b)) : 0;
    var tone = light >= MIN && light > dark ? 'light' : 'dark';
    header.setAttribute('data-ww-header-tone', tone);
    header.setAttribute('data-ww-header-contrast', (tone === 'light' ? light : dark).toFixed(2));
  }
  function start() {
    var header = document.querySelector('.site-header');
    if (!header || !document.querySelector('[data-ww-header-backdrop]')) return;
    var frame;
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(function () { update(header); }); }
    schedule();
    window.addEventListener('load', schedule);
    window.addEventListener('resize', schedule, { passive: true });
    var img = document.querySelector('[data-ww-header-backdrop] img');
    if (img && !img.complete) img.addEventListener('load', schedule, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

/* ww-header-nav-runtime v2 */
(function () {
  function start() {
    var header = document.querySelector('.site-header:not(.ww-source-header)');
    var inner = header && header.querySelector('.header-inner');
    // The menu list: #primary-nav where the site named it, else the first list inside the header's nav (a site built
    // or migrated without the id still gets one row, and a More menu, rather than nothing).
    var nav = inner && (inner.querySelector('#primary-nav') || inner.querySelector('nav > ul, nav ul, ul.nav-list'));
    if (nav) nav.setAttribute('data-ww-nav-list', '');
    if (!nav) return;
    var root = nav;
    while (root.parentElement && root.parentElement !== inner) root = root.parentElement;
    var brand = inner.querySelector(':scope>.brand,:scope>[class*="brand"],:scope>[class*="logo"]') || inner.querySelector(':scope>a');
    var toggle = header.querySelector('[data-ww-behavior~="nav-toggle"]');
    if (root.parentElement !== inner || !brand || brand === root) return;
    root.setAttribute('data-ww-nav-root', '');
    brand.setAttribute('data-ww-nav-brand', '');
    var actions = Array.prototype.filter.call(nav.children, function (li) { return li.querySelector('[data-ww-header-action],a[href="/cart/"],a[href="/cart"]'); });
    var shelf = null, width = -1, more = null;
    // The "More" menu: a button at the end of the row that opens a list of the buttons that did not fit.
    function moreMenu() {
      if (more) return more;
      more = document.createElement('li');
      more.className = 'ww-nav-more';
      more.hidden = true;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ww-nav-more-toggle';
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-haspopup', 'true');
      button.textContent = nav.getAttribute('data-ww-more-label') || 'More';
      var list = document.createElement('ul');
      list.className = 'ww-nav-more-list';
      list.hidden = true;
      button.addEventListener('click', function () { var open = list.hidden; list.hidden = !open; button.setAttribute('aria-expanded', String(open)); });
      document.addEventListener('click', function (event) { if (!more.contains(event.target) && !list.hidden) { list.hidden = true; button.setAttribute('aria-expanded', 'false'); } });
      more.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !list.hidden) { list.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); } });
      more.appendChild(button);
      more.appendChild(list);
      return more;
    }
    // Every button back in the row, in its original order, and the More menu emptied.
    function restore() {
      if (!more || more.hidden) return;
      var list = more.lastChild;
      while (list.firstChild) nav.insertBefore(list.firstChild, more);
      more.hidden = true;
      more.firstChild.setAttribute('aria-expanded', 'false');
      list.hidden = true;
    }
    // Move the last ordinary buttons into More, one at a time, until the row fits (or only two are left).
    function fold() {
      var menu = moreMenu();
      if (!menu.parentNode) nav.appendChild(menu);
      var ordinary = function () { return Array.prototype.filter.call(nav.children, function (li) { return li !== menu && actions.indexOf(li) < 0; }); };
      var folded = 0;
      while (!menuFits() && ordinary().length > 2 && folded < 40) {
        var items = ordinary();
        menu.hidden = false;
        menu.lastChild.insertBefore(items[items.length - 1], menu.lastChild.firstChild);
        folded++;
      }
      return menuFits();
    }
    function place(inRow) {
      if (!actions.length) return;
      if (!inRow && !shelf) { shelf = document.createElement('ul'); shelf.className = 'ww-header-actions'; inner.insertBefore(shelf, root); }
      actions.forEach(function (li) { (inRow ? nav : shelf).appendChild(li); });
      if (shelf) shelf.hidden = inRow;
    }
    function fits(el) { return el.scrollWidth <= el.clientWidth + 1; }
    // The menu fits only when nothing runs past the header either: a list whose container has no width of its own
    // (one sized by its content) measures as fitting itself while it runs off the screen.
    function menuFits() { return fits(nav) && fits(inner) && nav.getBoundingClientRect().right <= inner.getBoundingClientRect().right + 1; }
    function mode(name, compact) { header.setAttribute('data-ww-nav', name); header.toggleAttribute('data-ww-nav-compact', compact); place(name === 'row'); }
    function update(force) {
      if (!force && inner.clientWidth === width) return;
      width = inner.clientWidth;
      restore();
      if (toggle && getComputedStyle(toggle).display !== 'none') { header.removeAttribute('data-ww-nav'); header.removeAttribute('data-ww-nav-compact'); place(true); return; }
      // Tightest acceptable first: one row beside the brand, then the menu's own row, then the row with a More menu.
      for (var i = 0; i < 4; i++) {
        mode(i < 2 ? 'row' : 'stacked', i % 2 === 1);
        if (i < 2 ? fits(inner) : menuFits()) return;
      }
      mode('stacked', true);
      if (fold()) { header.setAttribute('data-ww-nav', 'more'); return; }
      mode('wrapped', true);
    }
    update(true);
    var frame;
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(function () { update(false); }); }
    window.addEventListener('resize', schedule, { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(inner);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { update(true); });
    window.addEventListener('load', function () { update(true); }, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
