# JavaScript Version

## Requirements

- Node.js 18+
- Python + ChromaDB (for the vector database server)
- [Ollama](https://ollama.com/download) installed and running

## Setup

```bash
# 1. Pull Ollama models
ollama pull nomic-embed-text
ollama pull qwen2.5:7b

# 2. Install ChromaDB (Python package — provides the database server)
python -m venv venv
pip install chromadb
chroma run --path ./rag_database

# 3. Install Node dependencies
cd js
npm install
```
## Test here

You can test the visualizations here: http://localhost:6601/visualize-d3.html 

## Starting ChromaDB

The JS version connects to ChromaDB running as a local HTTP server.
You need to start it in a separate terminal before running any commands:

```bash
# Run this from the project root (skinny_dip_proto/)
source venv/bin/activate
chroma run --path ./rag_database
```

Leave this terminal running. ChromaDB listens on `http://localhost:8000`.

> **Why?** The Python version embeds ChromaDB directly in-process.
> The JavaScript client doesn't support embedded mode — it connects over HTTP instead.

## Usage

Open a second terminal in the `js/` folder.

### Build the database

Drop PDFs into `../docs/` first, then:

```bash
node rag_web.js build   # for web version
node rag.js build       # for CLI version
```

### Web interface

```bash
node rag_web.js serve
```

Open `http://localhost:6601` in your browser.

### CLI — interactive mode

```bash
node rag.js
```

### CLI — single question

```bash
node rag.js ask "what is this document about?"
```

### CLI — check database stats

```bash
node rag.js stats
```

### Seeds canvas

An infinite canvas with a tray of ten random provocations on the right. Drag a
seed out of the tray and it becomes a card on the canvas, where it can spawn
further cards by asking real questions of the corpus.

```bash
npm run build:seeds   # once, and after editing seeds/app.jsx
node rag_web.js serve
```

Open `http://localhost:6601/seeds.html`.

Built on [React Flow](https://reactflow.dev) — it supplies the pan/zoom canvas,
the dot grid, the zoom controls, and node dragging.

| Path | What it is |
| --- | --- |
| `seeds.html` | Shell page — loads the bundle, nothing else |
| `seeds/app.jsx` | The canvas and tray. **Edit this one.** |
| `seeds/seeds.css` | Tray, card, menu, and React Flow styling |
| `seeds/build.mjs` | esbuild config → `static/` (gitignored) |

`npm run watch:seeds` rebuilds on save.

The tray's cards come from `/provocations`, which reads
`provocations_with_sources.csv` (falling back to `provocations.csv`) and
returns a random sample with `?n=10`. `parseSources` in `csv.js` splits each
`sources` cell back into `{ file, passages[] }` server-side — splitting on the
full `" | "` sequence rather than a bare pipe, so passages containing a stray
quote or pipe survive intact — and the canvas gets structured data rather than
a string to pick apart.

#### The three kinds of on-canvas card

There is exactly **one** globally-selected card and one active highlighted
snippet for the whole app at any time — both live as plain state in `Canvas`
and are threaded down to every node via `SelectionContext`, deliberately
*not* as local per-node `useState` (an earlier version of `CardNode` did
that; if you're tempted to give a node its own "am I open" flag again,
don't — nothing would then stop two cards from showing UI open at once).

- **`card`** (black) — a provocation dropped from the tray, or a seed
  planted on the canvas. No menu, no highlighting — hovering reveals a
  one-time **Expand ⌄** pill (`CardNode`). Clicking it fans that card's
  three real retrieved passages out as `branch` cards, joined by curved
  arrows with no edge label (nothing was clicked to name them), then the
  pill disappears for good — it's a one-time reveal, not a toggle. The
  passages are the same ones `/provocations` already attached to the seed;
  this never makes a network call itself.
- **`branch`** (white) — a generated card, produced by an action pill or a
  custom question on some other card's menu. Clicking one opens its action
  menu (`BranchNode` + `BranchMenu`); dragging never does. Selecting text in
  its title or body highlights it (a persistent `<mark>`) and scopes the
  menu to that snippet via an "Acting on: …" pill, until an action is taken
  (which makes the highlight permanent) or the selection is abandoned
  (which removes it — see `activateSnippet`/`confirmSnippet` in `Canvas`).
  Every `branch` card is exactly as interactive as any other — chain off of
  one indefinitely.
- **`annotation`** (white, dashed) — a free-text sticky note. Double-click
  blank canvas, or click the "+" that previews after resting the pointer on
  blank space for ~450ms, to add one. No menu, no highlighting, just an
  auto-growing `<textarea>` and delete.

#### The action menu and the six pills

A `branch` card's menu offers six colored pills plus a free-text "Ask your
own question…" input (Enter submits). Each pill is defined once, in the
`ACTIONS` array near the top of `app.jsx`:

| Pill | Real mechanism | Branches produced |
| --- | --- | --- |
| Find evidence | `POST /seed-evidence` — retrieval only, no LLM. Pulls real chunks straight from the `docs` Chroma collection using the card's own text (or its highlighted snippet) as the query. | however many chunks come back (`config.rag.nResults`) |
| Find a neighbor | `POST /seed-generate` — real retrieval **and** real Ollama generation, using a pill-specific question built by `questionFor()` | 2 (two independent calls) |
| Counterexample | same as above | 2 (two independent calls) |
| Compare this | same as above | 1 |
| Zoom in | same as above | 1 |
| Zoom out | same as above | 1 |
| *(custom question)* | `POST /seed-generate` with the typed text verbatim | 1 |

`/seed-evidence` and `/seed-generate` (both in `rag_web.js`, right after
`/ask`) are new, small, self-contained endpoints — they mirror `query()`'s
retrieval logic but are kept separate from `/ask` on purpose (this repo
duplicates RAG logic across files rather than sharing it; see `AGENTS.md`),
so the main chat endpoint's prompt and behavior are untouched.
`/seed-generate` asks Ollama for a short title *and* a body in one
generation call (`TITLE:` / `BODY:` lines it then splits apart), since
branch cards need both and there's no separate title-writing step anywhere
else — `generateBranch()` in `rag_web.js` falls back to the response's first
line as the title if the model drops the `TITLE:` label, which `qwen2.5:7b`
does occasionally.

New siblings from the same action fan out vertically around the parent's
current center, and repeated actions on the *same* parent cascade further
right each time (`spawnChildren`'s `cascade` offset) rather than stacking
new cards on top of old ones.

#### Sources

`branch` cards carry real citations, never placeholders. Each source chip
(`SourceChip`) shows a gray "report" chip for the corpus document that fed
the answer, hovering it reveals a popover with the actual quoted passage —
no fake sources are ever added just because a card came from generation
rather than retrieval.

#### Image seeds

Drop plain image files into `images/` at the repo root (siblings of `js/`,
`docs/`, etc — `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`, case-insensitive;
anything else is ignored), then:

```bash
npm run build:images   # hand-run, not automatic — re-run whenever images/ changes
```

This copies each accepted file into `js/static/seed-images/` under a new,
sequentially-numbered name (`seed-image-01.png`, `seed-image-02.png`, … in
whatever order the filesystem lists `images/` — **not** a stable id across
regenerations; adding/removing/reordering source files reshuffles the
numbers) and writes one record per image to `seed_images.json`, which
`/seed-images` serves as-is. `App`'s boot fetch pulls both `/provocations`
and `/seed-images` and interleaves them (`interleaveSeeds`) at roughly one
image per three text seeds, with any leftover images appended once text
seeds run out — so the gallery reads as a mix, not a wall of quotes
followed by a photo dump.

Image seeds are the most restricted card type on purpose (`ImageNode`):
draggable, and that's the entire interaction surface. No click handler, no
menu, no highlighting (no text to highlight), no delete button, no Expand,
no `Handle` — nothing ever spawns from or connects to one. A click on an
image card still bubbles up to `Canvas`'s central `onNodeClick`, which
closes whatever else was selected exactly like a click on blank canvas
would, purely because it isn't a `branch` card — nothing image-specific
was needed for that part.

#### Deliberately out of scope for now

One thing `UX_SPEC.md`'s reference build has that this repo's seeds canvas
does not (yet): **gallery seeds are drag-only.** Clicking or highlighting a
card *inside* the tray (before it's on the canvas) doesn't open a menu —
only dragging it onto the canvas does anything. Tray seeds (text and image
alike) are also still consumed on drop; delete the `setSeeds(...)` filter
in `Canvas`'s `onDrop` to let one be dragged out more than once.

Every card uses one type size (`.card-text` / `.branch-body`) whatever the
text length — a long quote grows the card downward rather than shrinking to
fit, so a canvas full of cards reads as a single weight.

### Provocation sources

Runs every row of `provocations.csv` through the retriever and writes
`provocations_with_sources.csv` with an added `sources` column holding the
source document and the passages that matched:

```bash
node provocations.js               # or: node provocations.js in.csv out.csv
```

Retrieval only — no LLM generation, since the sources come straight from the
returned chunks. Needs ChromaDB running, same as everything else.

## Running order (summary)

```
Terminal 1: chroma run --path ./rag_database   ← keep running
Terminal 2: node rag_web.js build              ← run once
Terminal 2: node rag_web.js serve              ← start the app
```

## Customization

### Change the model

In `rag.js` or `rag_web.js`, at the top of the file:

```js
const LLM_MODEL = 'llama3.2:1b';   // faster, less accurate
const LLM_MODEL = 'llama3.1:8b';   // slower, more accurate
```

### Change chunk size

```js
const CHUNK_SIZE    = 500;
const CHUNK_OVERLAP = 50;
```

### Change number of retrieved chunks

```js
const results = await collection.query({
  queryEmbeddings: [res.embedding],
  nResults: 3,   // increase to pull more context
});
```

### Change the port

```js
const PORT = 6601;
```

## Troubleshooting

**"Connection refused" or ChromaDB errors**

ChromaDB server isn't running. Start it first:
```bash
chroma run --path ./rag_database
```

**"No database found"**
```bash
node rag_web.js build
```

**The page still shows the old build after `npm run build:seeds`**

Hard-reload once (Cmd+Shift+R). The server sends `Cache-Control: no-cache` on
`/static` and `seeds.html` so this shouldn't recur, but a tab that was already
open before that header existed can still be holding a stale bundle in Chrome's
memory cache.

**Port already in use**
```bash
lsof -i :6601        # Mac/Linux
netstat -ano | findstr :6601   # Windows
```

**`No matching export ... handleAttributionWarning` when building seeds**

`@xyflow/react` is pinned to an exact `12.11.2` in `package.json`. Versions
12.11.3 and 12.11.4 import a symbol that `@xyflow/system@0.0.80` doesn't
export, so they fail to bundle. Don't loosen it to a caret range without
checking that upstream has published a matching `@xyflow/system`.

**Slow responses**
- Switch to a smaller model
- Reduce `nResults` in the query
- Check Ollama is using GPU: `ollama ps`
