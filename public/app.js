// Cache Calc — client-side bidirectional solver.
// Every input field carries one of three states: 'empty', 'user', 'auto'.
// Each user edit gets a monotonically-increasing recency stamp. A derivation
// rule can only overwrite a target field if at least one of its inputs has a
// higher recency than the target — i.e. "the value you most recently typed
// always wins". This is what makes both sides of an equation editable.

(() => {
  // ─────────────────────────────── constants ───────────────────────────────
  const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

  // DOM-input field metadata. `kind: 'size'` means the input is paired with a
  // unit selector and stored internally in bytes. `kind: 'int'` is a plain
  // integer (bits / counts). All values are stored in canonical units in
  // `vals` regardless of the unit the user selects.
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

  const SESSION_VOTED_KEY = 'cachecruncher-feedback-voted';
  const FEEDBACK_TOTALS_CACHE_KEY = 'cachecruncher-feedback-totals';
  const SERVER_FEEDBACK_URL = '/api/feedback';
  const FEEDBACK_TYPES = [
    { id: 'love', emoji: '❤️‍🔥', label: 'Flaming heart' },
    { id: 'death', emoji: '💀', label: 'Death' },
  ];
  const feedbackCounts = Object.fromEntries(FEEDBACK_TYPES.map(({ id }) => [id, 0]));
  let feedbackTotal = 0;
  const SIMULATOR_TRACE_LIMIT = 12;

  const simulator = {
    configKey: '',
    lines: [],
    tlb: [],
    replacement: [],
    trace: [],
    accessCount: 0,
    lastAccess: null,
  };

  // ─────────────────────────────── state ───────────────────────────────────
  const state = {};      // id -> 'empty' | 'user' | 'auto'
  const editedAt = {};   // id -> recency counter
  let recencyCounter = 0;
  let activeId = null;   // id currently focused (never overwritten by solver)

  for (const id of Object.keys(FIELDS)) {
    state[id] = 'empty';
    editedAt[id] = 0;
  }

  // ─────────────────────────────── helpers ─────────────────────────────────
  const isPow2 = (x) => Number.isFinite(x) && x > 0 && (x & (x - 1)) === 0;
  const ilog2 = (x) => {
    if (!Number.isFinite(x) || x <= 0) return null;
    const l = Math.log2(x);
    const r = Math.round(l);
    return Math.abs(l - r) < 1e-9 ? r : l; // exact for powers of 2
  };

  const $ = (id) => document.getElementById(id);

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
    const el = $(id);
    const raw = el.value.trim();
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    if (f.kind === 'size') {
      const unit = $(f.unitId).value;
      return n * UNITS[unit];
    }
    return n;
  }

  function writeField(id, canonical) {
    if (id === activeId) return false; // never overwrite focused input
    const f = FIELDS[id];
    const el = $(id);
    let display;
    if (canonical === null || canonical === undefined || !Number.isFinite(canonical)) {
      display = '';
    } else if (f.kind === 'size') {
      const unit = $(f.unitId).value;
      const v = canonical / UNITS[unit];
      display = formatNum(v);
    } else {
      display = formatNum(canonical);
    }
    if (el.value === display) return false;
    el.value = display;
    state[id] = display === '' ? 'empty' : 'auto';
    el.classList.toggle('auto-filled', state[id] === 'auto');
    return true;
  }

  function formatNum(n) {
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return Number(n.toFixed(6)).toString();
  }

  function readAll() {
    const v = {};
    for (const id of Object.keys(FIELDS)) v[id] = readField(id);
    return v;
  }

  function formatFeedbackSummary() {
    return `${feedbackTotal} interactions · ${FEEDBACK_TYPES.map(({ id, emoji }) => `${emoji} ${feedbackCounts[id]}`).join(' · ')}`;
  }

  function intValue(value) {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    return Math.abs(value - rounded) < 1e-9 ? rounded : null;
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

  function isUsableSimulatorConfig(v) {
    const blockSize = intValue(v.block_size);
    const numSets = intValue(v.num_sets);
    const associativity = intValue(v.associativity);
    const addressSize = intValue(v.address_size);
    const numBlocks = intValue(v.num_blocks);
    if (!blockSize || !numSets || !associativity || !addressSize || !numBlocks) return false;
    if (!isPow2(blockSize) || !isPow2(numSets)) return false;
    if (numBlocks !== numSets * associativity) return false;
    return addressSize > 0;
  }

  function getSimulatorConfig(v) {
    if (!isUsableSimulatorConfig(v)) return null;
    const pageSize = intValue(v.pagesize);
    const virtualAddressSize = intValue(v.virtual_address_size);
    const tlbRows = intValue(v.tlb_rows);
    const pageOffsetBits = pageSize && isPow2(pageSize) ? ilog2(pageSize) : null;
    const physicalPages = pageSize && intValue(v.addressable_memory)
      ? intValue(v.addressable_memory) / pageSize
      : null;
    const vpnBits = virtualAddressSize != null && pageOffsetBits != null
      ? virtualAddressSize - pageOffsetBits
      : null;
    return {
      blockSize: intValue(v.block_size),
      numSets: intValue(v.num_sets),
      associativity: intValue(v.associativity),
      addressSize: intValue(v.address_size),
      numBlocks: intValue(v.num_blocks),
      offsetBits: intValue(v.offset_bits) ?? ilog2(intValue(v.block_size)),
      indexBits: intValue(v.index_bits) ?? ilog2(intValue(v.num_sets)),
      tagBits: intValue(v.tag_bits),
      memoryBytes: intValue(v.addressable_memory) ?? (2 ** intValue(v.address_size)),
      pageSize,
      pageOffsetBits,
      physicalPages: intValue(physicalPages),
      virtualAddressSize,
      vpnBits: intValue(vpnBits),
      tlbRows,
    };
  }

  function supportsVirtualTranslation(config) {
    return Boolean(
      config
      && config.pageSize
      && config.pageOffsetBits != null
      && config.physicalPages
      && config.virtualAddressSize
      && config.vpnBits != null,
    );
  }

  function getConfigKey(config) {
    return JSON.stringify(config);
  }

  function ensureSimulator(config) {
    const key = getConfigKey(config);
    if (simulator.configKey === key) return;
    simulator.configKey = key;
    simulator.lines = Array.from({ length: config.numSets }, () =>
      Array.from({ length: config.associativity }, (_, way) => ({
        way,
        valid: false,
        tag: null,
        blockNumber: null,
        baseAddress: null,
        dirty: false,
        lastUsed: 0,
      })),
    );
    simulator.tlb = config.tlbRows && isPow2(config.tlbRows)
      ? Array.from({ length: config.tlbRows }, (_, index) => ({
          index,
          valid: false,
          tag: null,
          vpn: null,
          physicalPage: null,
        }))
      : [];
    simulator.replacement = Array.from({ length: config.numSets }, () => 0);
    simulator.trace = [];
    simulator.accessCount = 0;
    simulator.lastAccess = null;
  }

  function resetSimulator() {
    simulator.configKey = '';
    simulator.lines = [];
    simulator.tlb = [];
    simulator.replacement = [];
    simulator.trace = [];
    simulator.accessCount = 0;
    simulator.lastAccess = null;
  }

  function clearSimulatorTrace(config) {
    if (!config) {
      resetSimulator();
      return;
    }
    simulator.configKey = '';
    ensureSimulator(config);
  }

  function parseAddressInput(raw, bitWidth) {
    const text = raw.trim();
    if (!text) return null;
    const value = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
    if (!Number.isFinite(value) || value < 0) return null;
    const maxAddress = (2 ** bitWidth) - 1;
    if (value > maxAddress) return null;
    return value;
  }

  function resolveAccess(inputAddress, mode, config) {
    if (mode === 'virtual') {
      ensureSimulator(config);
      const vpn = Math.floor(inputAddress / config.pageSize);
      const pageOffset = inputAddress % config.pageSize;
      const tlbIndex = config.tlbRows && isPow2(config.tlbRows) ? vpn % config.tlbRows : null;
      const tlbTag = config.tlbRows && isPow2(config.tlbRows) ? Math.floor(vpn / config.tlbRows) : null;
      const tlbEntry = tlbIndex != null ? simulator.tlb[tlbIndex] : null;
      const tlbHit = Boolean(tlbEntry && tlbEntry.valid && tlbEntry.tag === tlbTag);
      const physicalPage = tlbHit ? tlbEntry.physicalPage : (vpn % config.physicalPages);
      if (tlbEntry && !tlbHit) {
        tlbEntry.valid = true;
        tlbEntry.tag = tlbTag;
        tlbEntry.vpn = vpn;
        tlbEntry.physicalPage = physicalPage;
      }
      const physicalAddress = (physicalPage * config.pageSize) + pageOffset;
      return {
        mode,
        inputAddress,
        virtualAddress: inputAddress,
        vpn,
        pageOffset,
        physicalPage,
        physicalAddress,
        tlbIndex,
        tlbTag,
        tlbHit,
        translationNote: `Demo translation uses VPN mod physical pages (${config.physicalPages}) after a direct-mapped TLB lookup.`,
      };
    }

    return {
      mode: 'physical',
      inputAddress,
      physicalAddress: inputAddress,
    };
  }

  function simulateAccess(address, config, translation, operation = 'read') {
    ensureSimulator(config);
    const blockNumber = Math.floor(address / config.blockSize);
    const setIndex = blockNumber % config.numSets;
    const tag = Math.floor(blockNumber / config.numSets);
    const offset = address % config.blockSize;
    const set = simulator.lines[setIndex];
    let line = set.find((entry) => entry.valid && entry.tag === tag);
    let outcome = 'Hit';
    let evicted = null;
    if (!line) {
      outcome = 'Miss';
      line = set.find((entry) => !entry.valid);
      if (!line) {
        line = set[simulator.replacement[setIndex] % set.length];
        simulator.replacement[setIndex] = (simulator.replacement[setIndex] + 1) % set.length;
        evicted = { dirty: line.dirty, blockNumber: line.blockNumber, tag: line.tag };
      }
      line.valid = true;
      line.tag = tag;
      line.blockNumber = blockNumber;
      line.baseAddress = blockNumber * config.blockSize;
      line.dirty = false;
    }
    simulator.accessCount += 1;
    line.lastUsed = simulator.accessCount;
    if (operation === 'write') {
      line.dirty = true;
    }
    const access = {
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
      translationNote: translation?.translationNote ?? '',
      blockNumber,
      setIndex,
      tag,
      offset,
      way: line.way,
      outcome,
      dirty: line.dirty,
      evicted,
      baseAddress: blockNumber * config.blockSize,
      bytes: Array.from({ length: Math.min(config.blockSize, 8) }, (_, index) => blockNumber * config.blockSize + index),
    };
    simulator.lastAccess = access;
    simulator.trace.unshift(access);
    simulator.trace = simulator.trace.slice(0, SIMULATOR_TRACE_LIMIT);
    return access;
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
    if (access.translationNote) {
      el.innerHTML += `<div class="translation-note">${escapeHtml(access.translationNote)}</div>`;
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
    const tagBits = binary.slice(0, config.tagBits || 0) || '—';
    const indexBits = binary.slice(config.tagBits || 0, (config.tagBits || 0) + config.indexBits) || '—';
    const offsetBits = binary.slice(binary.length - config.offsetBits) || '—';
    el.className = 'bit-breakdown';
    el.innerHTML = [
      ['Op', access.operation.toUpperCase()],
      ['Tag', tagBits],
      ['Index', indexBits],
      ['Offset', offsetBits],
      ['Result', `${access.outcome} in set ${access.setIndex}, way ${access.way}`],
      ['Dirty', access.dirty ? '1' : '0'],
    ].map(([label, value]) => `<div class="bit-cell"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
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

  function renderTrace() {
    const el = $('simTrace');
    if (!simulator.trace.length) {
      el.innerHTML = '<li class="trace-empty">No addresses accessed yet.</li>';
      return;
    }
    el.innerHTML = simulator.trace.map((access) => `
      <li class="trace-item ${access.outcome.toLowerCase()}">
        <div><strong>${escapeHtml(`${access.operation.toUpperCase()} ${access.mode === 'virtual' ? `${toHex(access.virtualAddress)} → ${toHex(access.address)}` : toHex(access.address)}`)}</strong> <span>${escapeHtml(access.outcome)}</span></div>
        <div>set ${access.setIndex} · way ${access.way} · tag ${escapeHtml(toHex(access.tag))} · block ${access.blockNumber}${access.mode === 'virtual' && access.tlbHit != null ? ` · tlb ${access.tlbHit ? 'hit' : 'miss'}` : ''}${access.evicted?.dirty ? ' · write-back' : ''}</div>
      </li>
    `).join('');
  }

  function renderTlbTable(config) {
    const el = $('simTlbTable');
    if (!config || !supportsVirtualTranslation(config) || !$('simAddressType') || $('simAddressType').value !== 'virtual') {
      el.className = 'table-shell empty-state';
      el.textContent = 'Switch to virtual mode to view TLB activity.';
      return;
    }
    if (!simulator.tlb.length) {
      el.className = 'table-shell empty-state';
      el.textContent = 'TLB rows will appear here.';
      return;
    }
    const rows = simulator.tlb.map((entry) => {
      const current = simulator.lastAccess && simulator.lastAccess.tlbIndex === entry.index;
      return `
        <tr class="${current ? 'active-row' : ''}">
          <td>${entry.index}</td>
          <td>${entry.valid ? '1' : '0'}</td>
          <td>${entry.valid ? escapeHtml(toHex(entry.tag)) : '—'}</td>
          <td>${entry.valid ? entry.vpn : '—'}</td>
          <td>${entry.valid ? entry.physicalPage : '—'}</td>
        </tr>
      `;
    }).join('');
    el.className = 'table-shell';
    el.innerHTML = `<table class="sim-table"><thead><tr><th>Row</th><th>V</th><th>TLB Tag</th><th>VPN</th><th>PPN</th></tr></thead><tbody>${rows}</tbody></table>`;
    scrollActiveRowIntoView(el);
  }

  function renderPageTable(config) {
    const el = $('simPageTable');
    if (!config || !supportsVirtualTranslation(config) || !$('simAddressType') || $('simAddressType').value !== 'virtual') {
      el.className = 'table-shell empty-state';
      el.textContent = 'Switch to virtual mode to view page table mappings.';
      return;
    }
    if (!simulator.lastAccess || simulator.lastAccess.vpn == null) {
      el.className = 'table-shell empty-state';
      el.textContent = 'Page table rows will appear here.';
      return;
    }
    const currentVpn = simulator.lastAccess.vpn;
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
    el.innerHTML = `<table class="sim-table"><thead><tr><th>VPN</th><th>PPN</th><th>Base</th><th>Status</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function renderCacheTable(config) {
    const el = $('simCacheTable');
    if (!config) {
      el.className = 'table-shell empty-state';
      el.textContent = 'Cache table will appear here.';
      return;
    }
    const headers = ['Set', 'Way', 'State', 'Mapping'];
    const rows = [];
    simulator.lines.forEach((set, setIndex) => {
      set.forEach((line) => {
        const current = simulator.lastAccess && simulator.lastAccess.setIndex === setIndex && simulator.lastAccess.way === line.way;
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
      });
    });
    el.className = 'table-shell';
    el.innerHTML = `<table class="sim-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    scrollActiveRowIntoView(el);
  }

  function renderMemoryTable(config) {
    const el = $('simMemoryTable');
    if (!config || !simulator.lastAccess) {
      el.className = 'table-shell empty-state';
      el.textContent = 'Memory blocks will appear here.';
      return;
    }
    const currentBlock = simulator.lastAccess.blockNumber;
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
    el.innerHTML = `<table class="sim-table"><thead><tr><th>Block</th><th>Start</th><th>End</th><th>Bytes</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function renderSimulator(v) {
    const config = getSimulatorConfig(v);
    const status = $('simStatus');
    const addBtn = $('simAddBtn');
    const randomBtn = $('simRandomBtn');
    const resetBtn = $('simResetBtn');
    const simInput = $('simAddress');

    if (!config) {
      resetSimulator();
      status.textContent = 'Configure power-of-two block size and set count, plus address bits, to unlock the Cache Simulator.';
      status.className = 'simulator-status';
      addBtn.disabled = true;
      randomBtn.disabled = true;
      resetBtn.disabled = true;
      simInput.disabled = true;
      renderBreakdown(null, null);
      renderTranslation(null, null);
      renderTrace();
      renderTlbTable(null);
      renderPageTable(null);
      renderCacheTable(null);
      renderMemoryTable(null);
      return;
    }

    const modeEl = $('simAddressType');
    const virtualSupported = supportsVirtualTranslation(config);
    modeEl.querySelector('option[value="virtual"]').disabled = !virtualSupported;
    if (!virtualSupported && modeEl.value === 'virtual') {
      modeEl.value = 'physical';
    }
    const mode = modeEl.value;

    ensureSimulator(config);
    status.textContent = `${config.associativity}-way cache · ${config.numSets} sets · ${config.blockSize}-byte blocks${mode === 'virtual' ? ' · virtual translation on' : ''}`;
    status.className = 'simulator-status ready';
    addBtn.disabled = false;
    randomBtn.disabled = false;
    resetBtn.disabled = false;
    simInput.disabled = false;
    renderTranslation(simulator.lastAccess, config);
    renderBreakdown(simulator.lastAccess, config);
    renderAddressChain(simulator.lastAccess, config);
    renderTrace();
    renderTlbTable(config);
    renderPageTable(config);
    renderCacheTable(config);
    renderMemoryTable(config);
  }

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

  // ─────────────────────────────── rules ───────────────────────────────────
  // Each rule: { target, inputs[], compute(v) -> number|null }.
  // Both directions of every relation are listed so any side can drive.
  const RULES = [
    // block_size ↔ offset_bits
    { target: 'block_size', inputs: ['offset_bits'],
      compute: (v) => v.offset_bits != null ? 2 ** v.offset_bits : null },
    { target: 'offset_bits', inputs: ['block_size'],
      compute: (v) => isPow2(v.block_size) ? ilog2(v.block_size) : null },

    // num_sets ↔ index_bits
    { target: 'num_sets', inputs: ['index_bits'],
      compute: (v) => v.index_bits != null ? 2 ** v.index_bits : null },
    { target: 'index_bits', inputs: ['num_sets'],
      compute: (v) => isPow2(v.num_sets) ? ilog2(v.num_sets) : null },

    // cache_size = num_blocks × block_size  (three-way)
    { target: 'num_blocks', inputs: ['cache_size', 'block_size'],
      compute: (v) => v.cache_size != null && v.block_size > 0 ? v.cache_size / v.block_size : null },
    { target: 'cache_size', inputs: ['num_blocks', 'block_size'],
      compute: (v) => v.num_blocks != null && v.block_size != null ? v.num_blocks * v.block_size : null },
    { target: 'block_size', inputs: ['cache_size', 'num_blocks'],
      compute: (v) => v.cache_size != null && v.num_blocks > 0 ? v.cache_size / v.num_blocks : null },

    // num_blocks = num_sets × associativity  (three-way)
    { target: 'num_blocks', inputs: ['num_sets', 'associativity'],
      compute: (v) => v.num_sets != null && v.associativity != null ? v.num_sets * v.associativity : null },
    { target: 'num_sets', inputs: ['num_blocks', 'associativity'],
      compute: (v) => v.num_blocks != null && v.associativity > 0 ? v.num_blocks / v.associativity : null },
    { target: 'associativity', inputs: ['num_blocks', 'num_sets'],
      compute: (v) => v.num_blocks != null && v.num_sets > 0 ? v.num_blocks / v.num_sets : null },

    // address_size = tag_bits + index_bits + offset_bits  (four-way)
    { target: 'tag_bits', inputs: ['address_size', 'index_bits', 'offset_bits'],
      compute: (v) => v.address_size != null && v.index_bits != null && v.offset_bits != null
        ? v.address_size - v.index_bits - v.offset_bits : null },
    { target: 'address_size', inputs: ['tag_bits', 'index_bits', 'offset_bits'],
      compute: (v) => v.tag_bits != null && v.index_bits != null && v.offset_bits != null
        ? v.tag_bits + v.index_bits + v.offset_bits : null },
    { target: 'index_bits', inputs: ['address_size', 'tag_bits', 'offset_bits'],
      compute: (v) => v.address_size != null && v.tag_bits != null && v.offset_bits != null
        ? v.address_size - v.tag_bits - v.offset_bits : null },
    { target: 'offset_bits', inputs: ['address_size', 'tag_bits', 'index_bits'],
      compute: (v) => v.address_size != null && v.tag_bits != null && v.index_bits != null
        ? v.address_size - v.tag_bits - v.index_bits : null },

    // address_size ↔ addressable_memory
    { target: 'addressable_memory', inputs: ['address_size'],
      compute: (v) => v.address_size != null ? 2 ** v.address_size : null },
    { target: 'address_size', inputs: ['addressable_memory'],
      compute: (v) => isPow2(v.addressable_memory) ? ilog2(v.addressable_memory) : null },

    // virtual_address_size ↔ virtual_memory
    { target: 'virtual_memory', inputs: ['virtual_address_size'],
      compute: (v) => v.virtual_address_size != null ? 2 ** v.virtual_address_size : null },
    { target: 'virtual_address_size', inputs: ['virtual_memory'],
      compute: (v) => isPow2(v.virtual_memory) ? ilog2(v.virtual_memory) : null },
  ];

  // ─────────────────────────────── solver ──────────────────────────────────
  function solve() {
    const v = readAll();
    // Provenance = max recency of inputs that produced a value.
    const recency = {};
    for (const id of Object.keys(FIELDS)) {
      recency[id] = state[id] === 'user' ? editedAt[id] : -1;
    }

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

        const inputRecency = Math.max(...rule.inputs.map((i) => recency[i]));
        const targetRecency = recency[rule.target];
        const cur = v[rule.target];

        if (cur == null) {
          v[rule.target] = result;
          recency[rule.target] = Math.max(inputRecency, 0);
          changed = true;
        } else if (Math.abs(cur - result) > 1e-9) {
          // Only overwrite if target is older than at least one input.
          // Active field is never overwritten.
          if (rule.target !== activeId && targetRecency < inputRecency) {
            v[rule.target] = result;
            recency[rule.target] = inputRecency;
            changed = true;
          }
        }
      }
    }

    return v;
  }

  // ─────────────────────────── derived display ─────────────────────────────
  // Compute output-only values (not editable) from the solved canonical state.
  function deriveExtras(v) {
    const e = {};
    e.num_tags = v.num_blocks;
    e.tag_space_bytes = (v.num_tags != null && v.tag_bits != null)
      ? (v.num_tags * v.tag_bits) / 8 : null;
    if (e.tag_space_bytes == null && v.num_blocks != null && v.tag_bits != null) {
      e.tag_space_bytes = (v.num_blocks * v.tag_bits) / 8;
    }
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

  // ───────────────────────────── rendering ─────────────────────────────────
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

  function renderResults(v, e) {
    const cacheRows = [
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
    ];
    const memRows = [
      ['Physical Address Space',  v.address_size != null ? `${fmtInt(v.address_size)} bits` : null],
      ['Physical Memory',         fmtBytes(v.addressable_memory)],
      ['Virtual Address Space',   v.virtual_address_size != null ? `${fmtInt(v.virtual_address_size)} bits` : null],
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
    ];
    paint('cacheResults', cacheRows);
    paint('memResults', memRows);
  }

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

  // ───────────────────────────── recompute ─────────────────────────────────
  let pending = false;
  function recompute() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const v = solve();
      // Write derived values back into form inputs.
      for (const id of Object.keys(FIELDS)) {
        if (id === activeId) continue;
        if (state[id] === 'user') continue; // don't touch user-typed values
        writeField(id, v[id]);
      }
      // Recompute "extras" (display-only) from the now-coherent vals.
      const e = deriveExtras(v);
      renderResults(v, e);
      renderSimulator(v);
    });
  }

  // ─────────────────────────────── wiring ──────────────────────────────────
  function attach() {
    for (const id of Object.keys(FIELDS)) {
      const el = $(id);
      el.addEventListener('focus', () => { activeId = id; });
      el.addEventListener('blur',  () => { if (activeId === id) activeId = null; recompute(); });
      el.addEventListener('input', (ev) => {
        if (!ev.isTrusted) return;
        const raw = el.value.trim();
        if (raw === '') {
          state[id] = 'empty';
          editedAt[id] = 0;
        } else {
          state[id] = 'user';
          editedAt[id] = ++recencyCounter;
        }
        el.classList.remove('auto-filled');
        recompute();
      });
      // Unit selector changes: rewrite the displayed number in the new unit
      // without changing canonical bytes.
      const f = FIELDS[id];
      if (f.kind === 'size') {
        const unitEl = $(f.unitId);
        let lastUnit = unitEl.value;
        unitEl.addEventListener('change', () => {
          const raw = el.value.trim();
          if (raw !== '') {
            const n = Number(raw);
            if (Number.isFinite(n)) {
              const canonical = n * UNITS[lastUnit];
              el.value = formatNum(canonical / UNITS[unitEl.value]);
            }
          }
          lastUnit = unitEl.value;
          recompute();
        });
      }
    }

    $('clearBtn').addEventListener('click', clearAll);
    $('resetBtn').addEventListener('click', clearAll);
    $('simAddBtn').addEventListener('click', handleSimulatorAccess);
    $('simRandomBtn').addEventListener('click', handleRandomAccess);
    $('simResetBtn').addEventListener('click', handleResetTrace);
    $('simAddressType').addEventListener('change', () => {
      $('simAddress').value = '';
      clearSimulatorTrace(getCurrentSimulatorConfig());
      renderSimulator(readAll());
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
  }

  function clearAll() {
    activeId = null;
    recencyCounter = 0;
    for (const id of Object.keys(FIELDS)) {
      const el = $(id);
      el.value = '';
      el.classList.remove('auto-filled');
      state[id] = 'empty';
      editedAt[id] = 0;
    }
    resetSimulator();
    $('simAddress').value = '';
    $('simAddressType').value = 'physical';
    $('simOperation').value = 'read';
    recompute();
  }

  function getCurrentSimulatorConfig() {
    return getSimulatorConfig(solve());
  }

  function handleSimulatorAccess() {
    const config = getCurrentSimulatorConfig();
    if (!config) return;
    const input = $('simAddress');
    const mode = $('simAddressType').value;
    const operation = $('simOperation').value;
    const bitWidth = mode === 'virtual' ? config.virtualAddressSize : config.addressSize;
    const address = parseAddressInput(input.value, bitWidth);
    if (address == null) {
      $('simStatus').textContent = `Enter an address between 0 and ${toHex((2 ** bitWidth) - 1)}.`;
      $('simStatus').className = 'simulator-status';
      return;
    }
    const translation = resolveAccess(address, mode, config);
    simulateAccess(translation.physicalAddress, config, translation, operation);
    $('simStatus').textContent = `Last ${operation} ${mode === 'virtual' ? `${toHex(address)} → ${toHex(translation.physicalAddress)}` : toHex(address)} → ${simulator.lastAccess.outcome} in set ${simulator.lastAccess.setIndex}, way ${simulator.lastAccess.way}${simulator.lastAccess.dirty ? ' · dirty' : ''}.`;
    $('simStatus').className = `simulator-status ready ${simulator.lastAccess.outcome.toLowerCase()}`;
    renderSimulator(readAll());
  }

  function handleRandomAccess() {
    const config = getCurrentSimulatorConfig();
    if (!config) return;
    const mode = $('simAddressType').value;
    const bitWidth = mode === 'virtual' ? config.virtualAddressSize : config.addressSize;
    const maxAddress = (2 ** bitWidth) - 1;
    const random = Math.floor(Math.random() * (maxAddress + 1));
    $('simAddress').value = toHex(random);
    handleSimulatorAccess();
  }

  function handleResetTrace() {
    const config = getCurrentSimulatorConfig();
    $('simAddress').value = '';
    clearSimulatorTrace(config);
    renderSimulator(readAll());
  }

  document.addEventListener('DOMContentLoaded', () => {
    attach();
    recompute();
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
(function(){function start(){var header=document.querySelector('.site-header');if(!header)return;function measure(){document.documentElement.style.setProperty('--ww-header-height',header.getBoundingClientRect().height+'px');}measure();if(typeof ResizeObserver!=='undefined')new ResizeObserver(measure).observe(header);}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();
