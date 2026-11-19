# Cache Cruncher

A modern, browser-based **cache, memory, and virtual-memory bits calculator** for computer-architecture students. Originally a Python/Flask app from a college course — rebuilt as a static Cloudflare Worker so it loads instantly and runs entirely in your browser.

**Live:** <https://cachecruncher.com>

## Features

- **Bidirectional auto-fill.** Type into either side of an equation (e.g. `cache_size` ↔ `num_blocks`, `block_size` ↔ `offset_bits`, `num_sets` ↔ `index_bits`, `address_size` ↔ `addressable_memory`, `pagesize` ↔ `page_offset_bits`) and the other side recomputes. The most-recently-edited field always wins.
- Cache configuration: blocks, sets, index/tag/offset bits, tag storage, valid-bit overhead.
- Memory configuration: physical/virtual address space, page size, virtual/physical pages, page-table size, VPN bits.
- TLB tag and index bits.
- Unit selectors (B / KB / MB / GB) with live unit conversion.
- Light / dark theme.
- Mobile-friendly responsive layout.
- Zero server compute for the page itself — everything runs client-side.
- A free JSON API for AI assistants and programs (below), running the same math.

## How the solver works

Each input field has one of three states: `empty`, `user`, or `auto`. Every keystroke from the user gets a monotonically-increasing recency stamp. A derivation rule may overwrite a field only when at least one of its inputs is *more recent* than the target. The currently-focused field is never touched. This is what makes both sides of every equation freely editable.

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

The page and the API run one file, `public/solver.js`, so they cannot disagree; `npm run check` covers both.

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
│   ├── solver.js   # the math: rules, working in words (shared by the page and the API)
│   └── app.js      # UI
├── src/
│   ├── worker.js     # the platform Worker
│   ├── site-routes.js # this site's own routes: /api/feedback, /api/solve, /openapi.json
│   └── solve-api.js  # the JSON API
├── scripts/verify-solver.mjs  # tests for the solver and the API
├── wrangler.jsonc
└── package.json
```

## License

MIT — free for student and educational use.
