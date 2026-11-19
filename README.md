# Cache Cruncher

A modern, browser-based **cache, memory, and virtual-memory bits calculator** for computer-architecture students. Originally a Python/Flask app from a college course — rebuilt as a static Cloudflare Worker so it loads instantly and runs entirely in your browser.

**Live:** <https://cachecruncher.com>

## Features

- **Bidirectional auto-fill.** Type into either side of an equation (e.g. `cache_size` ↔ `num_blocks`, `block_size` ↔ `offset_bits`, `num_sets` ↔ `index_bits`, `address_size` ↔ `addressable_memory`, `pagesize` ↔ `page_offset_bits`) and the other side recomputes. The most-recently-edited field always wins.
- **The working, shown.** Every result comes with its formula and the numbers that went in, and an address-layout bar shows where tag, index and offset sit in the address.
- **Plain warnings** when the numbers do not describe a real cache (a set count that is not a power of two, a block count that is not whole).
- **Cache simulator** with LRU or FIFO replacement. Step one address at a time, or paste a whole list and get the hit/miss table and hit rate a homework question asks for.
- **Examples and links.** One-click starting points, and the address bar always carries the values you typed, so any setup can be bookmarked or shared (`/?cache_size=32KB&block_size=64&associativity=4&address_size=32`).
- Cache configuration: blocks, sets, index/tag/offset bits, tag storage, valid-bit overhead.
- Memory configuration: physical/virtual address space, page size, virtual/physical pages, page-table size, VPN bits.
- TLB tag and index bits.
- Unit selectors (B / KB / MB / GB) with live unit conversion.
- Light / dark theme.
- Mobile-friendly responsive layout.
- Zero server compute for the page itself — everything runs client-side.
- A free JSON API for AI assistants and programs (below), running the same math.

## How the solver works

Each input field has one of three states: `empty`, `user` (you typed it), or `auto` (worked out). Every keystroke gets a rising recency stamp.

Everything shown is derived from the typed values only, never from earlier results. Going from the newest typed value to the oldest, a value is kept unless the newer ones already settle that field to something else; in that case it is marked as replaced, and it is rewritten with the derived value when you leave the box you are typing in (a note says what changed and why). The empty fields are then filled in from the kept values, each by the first rule that can, so the answer does not depend on the order things were derived in. The currently-focused field is never rewritten under the cursor. This is what makes both sides of every equation freely editable.

The simulator states its assumptions on the page: byte addresses; an empty way is filled before anything is replaced; LRU or FIFO replacement; a direct-mapped TLB; and a stand-in page table (virtual page n maps to physical page n mod the number of physical pages), so nothing page-faults.

## JSON API (for AI assistants and programs)

LLMs are unreliable at `log2` and unit conversions, so the calculator's math is also available as a plain URL. No key, nothing stored.

```
GET https://cachecruncher.com/api/solve?cache_size=32KB&block_size=64&associativity=4&address_size=32
```

Give any combination of known values; every other value that can be derived comes back, with the working in words:

```json
{
  "ok": true,
  "values":  { "num_blocks": 512, "num_sets": 128, "offset_bits": 6, "index_bits": 7, "tag_bits": 19, "...": "..." },
  "derived": { "tag_storage_bytes": 1216, "valid_bit_storage_bytes": 64, "...": "..." },
  "formatted": { "Cache Size": "32 KB", "Tag Bits": "19", "...": "..." },
  "steps": ["Offset bits = log2(block size) = log2(64) = 6.", "Number of blocks = cache size / block size = 32768 / 64 = 512.", "..."],
  "warnings": [],
  "not_determined": {}
}
```

- **Parameters** are the calculator's field ids: `cache_size`, `block_size`, `num_blocks`, `associativity`, `num_sets`, `index_bits`, `tag_bits`, `offset_bits`, `address_size`, `addressable_memory`, `virtual_address_size`, `virtual_memory`, `pagesize`, `tlb_rows`, `protection_bits`.
- **Sizes** take a unit (`32KB`, `0.5MB`, `1TB`; 1 KB = 1024 bytes) or a bare number of bytes, or a bare number plus the page's unit parameter (`cache_size=32&cache_unit=KB`; likewise `addr_mem_unit`, `virt_mem_unit`, `page_unit`).
- **Contradictory values** (`cache_size=32KB&block_size=64&num_blocks=500`) return `422` with the conflict spelled out, instead of one value silently winning. Values that are not powers of two, or that are not whole numbers, come back as `warnings`. A malformed request is `400` with a message saying what to fix.
- **`not_determined`** names the results it could not work out and what each one needs.
- `GET /openapi.json` is the OpenAPI 3.1 description. A ChatGPT custom GPT can import it as an Action (in the GPT editor: Create new action → Import from URL → `https://cachecruncher.com/openapi.json`), and any function-calling app can use it as a tool definition. CORS is open.

The answer also carries `calculator`, a link that opens the web calculator with the same values filled in.

The page and the API run one file, `public/solver.js`, so they cannot disagree; `npm run check` covers both. The script and style files are cached for a day, so `layout/` loads them with a version (`/app.js?v=2`): bump it whenever they change together.

## Develop & deploy

```bash
npm install
npm run dev      # local preview at http://localhost:8787
npm run deploy   # publish to Cloudflare
```

You'll need [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and a Cloudflare account.

## Project layout

```
cache-calc/
├── public/         # static assets served by the Worker
│   ├── index.html
│   ├── styles.css
│   ├── solver.js   # the math: rules, working in words, the simulator, link parsing (shared by the page and the API)
│   └── app.js      # the form, the pictures and the simulator's controls
├── src/
│   ├── worker.js     # the platform Worker
│   ├── site-routes.js # this site's own routes: /api/feedback, /api/solve, /openapi.json
│   └── solve-api.js  # the JSON API
├── scripts/verify-solver.mjs     # tests for the solver, the page's rules and the API
├── scripts/verify-simulator.mjs  # tests for the simulator (the real code, in solver.js)
├── wrangler.jsonc
└── package.json
```

## License

MIT — free for student and educational use.
