// Checks the cache simulator in public/solver.js: the code the page runs, not a copy of it. Run by `npm run check`.
import assert from 'node:assert/strict';
import '../public/solver.js';

const Solver = globalThis.CacheCruncherSolver;
let checks = 0;
function check(name, fn) {
  try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

const configFor = (given) => Solver.simConfig(Solver.solve(given).values);
const outcomes = (sim, addresses) => addresses.map((address) => Solver.simAccess(sim, address).outcome[0]).join('');

check('an address splits into tag, set and offset', () => {
  // 32 KB, 4-way, 64-byte blocks: 128 sets, 6 offset bits, 7 index bits.
  const config = configFor({ cache_size: 32768, block_size: 64, associativity: 4, address_size: 32 });
  assert.deepEqual([config.numSets, config.offsetBits, config.indexBits, config.tagBits], [128, 6, 7, 19]);
  const sim = Solver.simCreate(config);
  const access = Solver.simAccess(sim, 0x12345678);
  assert.equal(access.offset, 0x12345678 & 0x3f);
  assert.equal(access.setIndex, (0x12345678 >>> 6) & 0x7f);
  assert.equal(access.tag, 0x12345678 >>> 13);
  assert.equal(access.blockNumber, Math.floor(0x12345678 / 64));
  assert.equal(access.outcome, 'Miss');
  assert.equal(Solver.simAccess(sim, 0x12345678 + 1).outcome, 'Hit'); // same block
});

check('direct-mapped: two blocks that share a set keep replacing each other', () => {
  const config = configFor({ cache_size: 64, block_size: 16, associativity: 1, address_size: 8 }); // 4 sets
  const sim = Solver.simCreate(config);
  assert.equal(outcomes(sim, [0, 64, 0, 64, 68, 70]), 'MMMMHH');
  assert.equal(sim.stats.replacements, 3);
});

check('LRU and FIFO choose different victims', () => {
  // One set, two ways. A, B, A, C: LRU replaces B (A was just used); FIFO replaces A (loaded first).
  const config = configFor({ cache_size: 32, block_size: 16, associativity: 2, address_size: 8 });
  assert.equal(config.numSets, 1);
  const [A, B, C] = [0, 16, 32];
  const lru = Solver.simCreate(config, 'lru');
  assert.equal(outcomes(lru, [A, B, A, C, A, B]), 'MMHMHM');
  const fifo = Solver.simCreate(config, 'fifo');
  assert.equal(outcomes(fifo, [A, B, A, C, A, B]), 'MMHMMM');
  assert.equal(Solver.simCreate(config, 'nonsense').policy, 'lru');
});

check('an empty way is used before anything is replaced, and counts add up', () => {
  const config = configFor({ cache_size: 64, block_size: 16, associativity: 4, address_size: 8 }); // 1 set, 4 ways
  const sim = Solver.simCreate(config);
  const ways = [0, 16, 32, 48].map((address) => Solver.simAccess(sim, address).way);
  assert.deepEqual(ways, [0, 1, 2, 3]);
  assert.equal(sim.stats.replacements, 0);
  const fifth = Solver.simAccess(sim, 64);
  assert.deepEqual(fifth.evicted, { tag: 0, blockNumber: 0, dirty: false });
  assert.deepEqual([sim.stats.accesses, sim.stats.hits, sim.stats.misses, sim.stats.replacements], [5, 0, 5, 1]);
});

check('a write marks the block dirty, and replacing it is a write-back', () => {
  const config = configFor({ cache_size: 16, block_size: 16, associativity: 1, address_size: 8 }); // one line
  const sim = Solver.simCreate(config);
  assert.equal(Solver.simAccess(sim, 0, 'write').dirty, true);
  const next = Solver.simAccess(sim, 16, 'read');
  assert.equal(next.evicted.dirty, true);
  assert.equal(next.dirty, false);
  assert.equal(sim.stats.writeBacks, 1);
});

check('virtual addresses go through a direct-mapped TLB', () => {
  const config = configFor({ cache_size: 1024, block_size: 16, associativity: 2, address_size: 16, virtual_address_size: 20, pagesize: 256, tlb_rows: 4 });
  assert.equal(Solver.simSupportsVirtual(config), true);
  assert.deepEqual([config.pageOffsetBits, config.vpnBits, config.physicalPages], [8, 12, 256]);
  const sim = Solver.simCreate(config);
  const first = Solver.simTranslate(sim, 0x12345);
  assert.deepEqual([first.vpn, first.pageOffset, first.tlbIndex, first.tlbTag, first.tlbHit], [0x123, 0x45, 0x123 % 4, Math.floor(0x123 / 4), false]);
  assert.equal(first.physicalAddress, ((0x123 % 256) * 256) + 0x45);
  assert.equal(Solver.simTranslate(sim, 0x123FF).tlbHit, true);          // same page
  assert.equal(Solver.simTranslate(sim, 0x12745).tlbHit, false);         // same TLB row, different tag
  assert.equal(Solver.simTranslate(sim, 0x12345).tlbHit, false);         // and it was replaced
  assert.deepEqual([sim.stats.tlbHits, sim.stats.tlbMisses], [1, 3]);
  const access = Solver.simAccess(sim, first.physicalAddress, 'read', first);
  assert.equal(access.mode, 'virtual');
  assert.equal(access.virtualAddress, 0x12345);
});

check('values that are not a runnable cache give no simulator', () => {
  assert.equal(configFor({ cache_size: 32768, block_size: 48, associativity: 4, address_size: 32 }), null); // block not a power of two
  assert.equal(configFor({ cache_size: 32768, block_size: 64, associativity: 3, address_size: 32 }), null); // sets not whole
  assert.equal(configFor({ cache_size: 32768, block_size: 64, associativity: 4 }), null);                    // no address size
  assert.equal(configFor({ cache_size: 32768, block_size: 64, associativity: 4, address_size: 10 }), null);  // address too small
  assert.equal(configFor({ cache_size: 32768, block_size: 64, associativity: 4, address_size: 64 }), null);  // beyond exact integers
});

check('a huge cache costs nothing until it is touched', () => {
  const config = configFor({ cache_size: 2 ** 40, block_size: 64, associativity: 8, address_size: 48 });
  const sim = Solver.simCreate(config);
  Solver.simAccess(sim, 2 ** 47 + 5);
  assert.equal(sim.sets.size, 1);
});

check('addresses read as hex, binary or decimal', () => {
  assert.equal(Solver.parseAddress('0x3F', 8), 63);
  assert.equal(Solver.parseAddress('0b111111', 8), 63);
  assert.equal(Solver.parseAddress('63', 8), 63);
  assert.equal(Solver.parseAddress('0xFFFF_FFFF', 32), 0xffffffff);
  assert.equal(Solver.parseAddress('256', 8), null);   // does not fit in 8 bits
  assert.equal(Solver.parseAddress('3F', 8), null);    // hex needs 0x
  assert.equal(Solver.parseAddress('-1', 8), null);
  assert.equal(Solver.parseAddress('', 8), null);
});

check('a pasted list becomes a run of reads and writes', () => {
  const trace = Solver.parseTrace('0x00 0x04, W 0x08\n12; r 16 nope', 8);
  assert.deepEqual(trace.accesses, [
    { address: 0, operation: 'read' }, { address: 4, operation: 'read' }, { address: 8, operation: 'write' },
    { address: 12, operation: 'read' }, { address: 16, operation: 'read' },
  ]);
  assert.deepEqual(trace.errors, ['nope']);
  assert.equal(trace.truncated, false);
  assert.equal(Solver.parseTrace('1 2 3', 8, 'write').accesses[0].operation, 'write');
  const long = Solver.parseTrace(Array.from({ length: Solver.TRACE_LIMIT + 10 }, (_, i) => i % 200).join(' '), 8);
  assert.equal(long.accesses.length, Solver.TRACE_LIMIT);
  assert.equal(long.truncated, true);
});

check('a textbook run: 8 one-word blocks, direct-mapped', () => {
  // Patterson & Hennessy's classic sequence of block addresses 22, 26, 22, 26, 16, 3, 16, 18 on an
  // 8-block direct-mapped cache: miss, miss, hit, hit, miss, miss, hit, miss (18 replaces 26).
  const config = configFor({ num_blocks: 8, block_size: 1, associativity: 1, address_size: 5 });
  const sim = Solver.simCreate(config);
  assert.equal(outcomes(sim, [22, 26, 22, 26, 16, 3, 16, 18]), 'MMHHMMHM');
  assert.equal(sim.last.evicted.blockNumber, 26);
});

console.log(`Simulator checks passed (${checks}).`);
