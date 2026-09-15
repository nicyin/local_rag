/**
 * Seeds canvas
 *
 * An infinite canvas (React Flow) with a tray of provocations on the right.
 * Drag a seed out of the tray and it becomes a card on the canvas, where it can
 * be moved around freely.
 *
 * There are three kinds of on-canvas card:
 *   - `card`       black, a provocation/seed. No menu, no highlighting — only a
 *                  one-time "Expand" affordance (see CardNode) that fans this
 *                  card's real retrieved passages out once, then disappears.
 *   - `branch`     white, a generated card — produced by an action pill, a
 *                  custom question, or a black card's Expand. Has its own
 *                  action menu, highlightable title/body, source chips.
 *   - `annotation` white/dashed, a free-text sticky note the user adds.
 *
 * Global selection model: there is exactly one "selected card" (whose menu is
 * showing) and one "active snippet" (which highlighted span, if any, that menu
 * is scoped to) for the whole app — both live in Canvas's own state and are
 * threaded down via SelectionContext, never as local per-card component state.
 * See js/README.md for the full interaction writeup.
 *
 * Bundled by build.mjs — edit this file, not the generated seeds.js.
 */

import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';
import './seeds.css';

const SEED_COUNT = 10;
const MIME = 'application/seed';

const CARD_W   = 305;   // black card width — must track .card-wrap width in seeds.css
const BRANCH_W = 260;   // white branch card width — must track .branch-wrap width in seeds.css
const GAP_X    = 170;   // horizontal run between a card and its children
const GAP_Y    = 230;   // vertical pitch of a fan; clears a full-height .branch
const CASCADE  = BRANCH_W + 50; // extra rightward offset per repeat action on the same parent

const HIGHLIGHT = '#befc6d'; // highlight mark / highlighted-snippet chip / custom-question color

// The six action pills (§5/§10 of UX_SPEC.md). `count` is how many branch
// cards a single click produces; 'evidence' is special-cased (its count is
// however many real chunks come back, not a fixed number).
const ACTIONS = [
  { id: 'neighbor',       label: 'Find a neighbor', color: '#ffc5ff', count: 2,
    tooltip: 'Surface a related idea or work from nearby in the corpus.' },
  { id: 'compare',        label: 'Compare this',    color: '#d3b0f9', count: 1,
    tooltip: 'Compare this against another idea or perspective.' },
  { id: 'counterexample', label: 'Counterexample',  color: '#93ffb9', count: 2,
    tooltip: 'Surface a case that pushes back on this.' },
  { id: 'zoomin',         label: 'Zoom in',         color: '#fe9544', count: 1,
    tooltip: 'Get a concrete, specific example of this.' },
  { id: 'zoomout',        label: 'Zoom out',        color: '#eaff00', count: 1,
    tooltip: 'Step back to see the broader pattern this fits into.' },
  { id: 'evidence',       label: 'Find evidence',   color: '#93e3ff', count: 'chunks',
    tooltip: 'Pull a supporting passage from the source material.' },
];

/** How each pill frames its call to /seed-generate. Not used for 'evidence'. */
function questionFor(actionId, text) {
  switch (actionId) {
    case 'neighbor':
      return `What's a related idea, example, or way of thinking that connects to this: "${text}"`;
    case 'compare':
      return `Compare this against another idea or perspective: "${text}"`;
    case 'counterexample':
      return `What's a case or example that pushes back on or contradicts this: "${text}"`;
    case 'zoomin':
      return `Give a concrete, specific example of this: "${text}"`;
    case 'zoomout':
      return `Step back — what's the broader pattern or bigger picture this fits into: "${text}"`;
    default:
      return text;
  }
}

// ── Highlight range helpers ─────────────────────────────────────────────────

/** Sorts and merges overlapping/adjacent {start,end} ranges into one list. */
function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  return merged;
}

/** Splits `text` into plain strings and <mark> spans per the given ranges. */
function renderHighlighted(text, ranges) {
  const merged = mergeRanges(ranges || []);
  if (!merged.length) return text;
  const parts = [];
  let cursor = 0;
  merged.forEach((r, i) => {
    const start = Math.max(0, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark className="hl" key={`m-${i}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** Flat character offset of (node, offset) within root, walking text nodes in order. */
function flatOffset(root, node, offset) {
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur;
  while ((cur = walker.nextNode())) {
    if (cur === node) return total + offset;
    total += cur.textContent.length;
  }
  return total;
}

/**
 * Interleaves image seeds among text seeds at a fixed ratio (roughly one
 * image after every third text seed), with any images left over once text
 * seeds run out appended at the end — so the gallery reads as a varied mix
 * rather than a wall of text followed by a photo dump (UX_SPEC.md §13).
 */
function interleaveSeeds(textSeeds, imageSeeds) {
  const result = [];
  let i = 0;
  textSeeds.forEach((seed, idx) => {
    result.push(seed);
    if ((idx + 1) % 3 === 0 && i < imageSeeds.length) result.push(imageSeeds[i++]);
  });
  while (i < imageSeeds.length) result.push(imageSeeds[i++]);
  return result;
}

/** The current browser selection, as {start,end,text} offsets within `root` — or null. */
function getSelectionRange(root) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const a = flatOffset(root, range.startContainer, range.startOffset);
  const b = flatOffset(root, range.endContainer, range.endOffset);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (start === end) return null;
  return { start, end, text: sel.toString() };
}

// ── Global selection context ────────────────────────────────────────────────
//
// The one shared slot of "what's selected / what's the active snippet" state
// (UX_SPEC.md §1). Canvas owns the actual state; every node component reads
// and drives it through here instead of local component state.

const SelectionContext = React.createContext(null);

// ── Small icons ───────────────────────────────────────────────────────────────

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="11" height="13" viewBox="0 0 11 13" fill="none" aria-hidden="true">
      <path d="M6.5.5H1.5v12h8V3.5L6.5.5zM6.5.5v3h3" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="5.2" stroke="currentColor" strokeWidth="1" />
      <path d="M.8 6h10.4M6 .8c1.6 1.6 1.6 8.8 0 10.4M6 .8C4.4 2.4 4.4 9.6 6 11.2" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

// ── Black card: provocation / seed-text ──────────────────────────────────────

/**
 * A dropped seed.
 *
 * The type size is the same on every card whatever the text length — a long
 * quote grows the card downward rather than shrinking to fit, so a wall of
 * cards reads as one weight. Short text sits at the bottom; long text fills.
 *
 * No menu, no highlighting (UX_SPEC.md §4) — the only interaction beyond drag
 * is the one-time "Expand" affordance, which fans this card's real retrieved
 * passages out as branch cards, then hides itself for good.
 */
function CardNode({ id, data }) {
  const { runExpand } = useContext(SelectionContext);
  const { setNodes, setEdges } = useReactFlow();

  // Taking a card away takes its children and their edges with it.
  const remove = (event) => {
    event.stopPropagation();
    setNodes((ns) => ns.filter((n) => n.id !== id && n.data?.parentId !== id));
    setEdges((es) => es.filter((e) => e.source !== id));
  };

  const onExpand = (event) => {
    event.stopPropagation();
    runExpand(id);
  };

  return (
    <div className="card-wrap">
      <div className="card">
        <p className="card-text">{data.text}</p>
      </div>

      {/* `nodrag` keeps a click on these from panning the node underneath. */}
      <button className="card-close nodrag" onClick={remove} title="Remove card" aria-label="Remove card">
        <CloseIcon />
      </button>

      {!data.hasExpanded && (
        <button className="card-expand nodrag" onClick={onExpand} title="Reveal this card's sources, once">
          Expand ⌄
        </button>
      )}

      {/* Anchor for the edges out to this card's children. Styled invisible. */}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// ── White card: generated / branch ───────────────────────────────────────────

function SourceChip({ source }) {
  const [hover, setHover] = useState(false);
  const isWeb = source.tag === 'web';

  return (
    <div
      className="chip-wrap"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className={`chip${isWeb ? ' chip--web' : ''}`}>
        {isWeb ? <GlobeIcon /> : <FileIcon />} Source
      </span>
      {hover && (
        <div className="chip-pop nodrag nowheel">
          <strong>Source from {isWeb ? 'online (web)' : 'report (corpus)'}</strong>
          <p>{source.citation}</p>
        </div>
      )}
    </div>
  );
}

/** The popover menu attached to a selected branch card (UX_SPEC.md §5). */
function BranchMenu({ cardId, snippet, busy, question, setQuestion, onAction, onCustom }) {
  const [tip, setTip] = useState(null);

  const submit = (event) => {
    if (event.key !== 'Enter') return;
    const text = question.trim();
    if (!text || busy) return;
    onCustom(cardId, text);
    setQuestion('');
  };

  return (
    <div className="branch-menu nodrag nowheel" onClick={(e) => e.stopPropagation()}>
      {snippet && (
        <div className="menu-scope">Acting on: &ldquo;{snippet.text}&rdquo;</div>
      )}

      <div className="menu-pills">
        {ACTIONS.map((a) => (
          <div
            className="pill-wrap"
            key={a.id}
            onMouseEnter={() => setTip(a.id)}
            onMouseLeave={() => setTip((t) => (t === a.id ? null : t))}
          >
            <button
              className="pill"
              style={{ background: a.color }}
              disabled={busy}
              onClick={() => onAction(cardId, a.id)}
            >
              {a.label}
            </button>
            {tip === a.id && <div className="pill-tip">{a.tooltip}</div>}
          </div>
        ))}
      </div>

      <input
        className="menu-question"
        type="text"
        placeholder={snippet ? 'Ask your own question about this…' : 'Ask your own question…'}
        value={question}
        disabled={busy}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={submit}
      />
    </div>
  );
}

/**
 * A generated/branch card — the one interactive white-card kind in the app.
 * Click opens its menu (UX_SPEC.md §5); dragging never does. Selecting text
 * in the title or body highlights it and scopes the menu to that snippet
 * (§6). Every generated card is just as interactive as any other — you can
 * keep chaining off of one indefinitely.
 */
function BranchNode({ id, data }) {
  const { selectedId, snippet, activateSnippet, runAction, runCustom, busyId } =
    useContext(SelectionContext);
  const { setNodes, setEdges } = useReactFlow();
  const [question, setQuestion] = useState('');

  const isSelected = selectedId === id;
  const isBusy = busyId === id;
  const activeSnippet = snippet && snippet.cardId === id ? snippet : null;

  const remove = (event) => {
    event.stopPropagation();
    setNodes((ns) => ns.filter((n) => n.id !== id && n.data?.parentId !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  };

  const onTextMouseUp = (field) => (event) => {
    const range = getSelectionRange(event.currentTarget);
    if (!range) return; // no fresh selection — let the click that follows behave normally
    activateSnippet(id, field, range.start, range.end, range.text);
  };

  const titleRanges = data.highlights?.title || [];
  const bodyRanges = data.highlights?.body || [];
  const liveTitleRanges = activeSnippet?.field === 'title' ? [...titleRanges, activeSnippet] : titleRanges;
  const liveBodyRanges  = activeSnippet?.field === 'body'  ? [...bodyRanges, activeSnippet]  : bodyRanges;

  return (
    <div className="branch-wrap">
      <div className="branch">
        {data.highlightedText && (
          <div className="branch-quote">&ldquo;{data.highlightedText}&rdquo;</div>
        )}

        <h3 className="branch-title nodrag" onMouseUp={onTextMouseUp('title')}>
          {renderHighlighted(data.title, liveTitleRanges)}
        </h3>

        <p className="branch-body nowheel nodrag" onMouseUp={onTextMouseUp('body')}>
          {renderHighlighted(data.body, liveBodyRanges)}
        </p>

        {!!data.sources?.length && (
          <div className="branch-sources">
            {data.sources.map((s, i) => <SourceChip key={i} source={s} />)}
          </div>
        )}
      </div>

      <button className="card-close nodrag" onClick={remove} title="Remove card" aria-label="Remove card">
        <CloseIcon />
      </button>

      {isSelected && (
        <BranchMenu
          cardId={id}
          snippet={activeSnippet}
          busy={isBusy}
          question={question}
          setQuestion={setQuestion}
          onAction={runAction}
          onCustom={runCustom}
        />
      )}

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// ── Annotation card ───────────────────────────────────────────────────────────

/** A free-text sticky note (UX_SPEC.md §9). No menu, no highlighting — just text and delete. */
function AnnotationNode({ id, data }) {
  const { setNodes, setEdges } = useReactFlow();
  const taRef = useRef(null);

  // Auto-focused the instant it's created — only then, not on later re-renders.
  useEffect(() => {
    if (data.autoFocus) taRef.current?.focus();
  }, []);

  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => { autoGrow(taRef.current); }, [data.text]);

  const remove = (event) => {
    event.stopPropagation();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  };

  const onChange = (event) => {
    const text = event.target.value;
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, text } } : n)));
  };

  return (
    <div className="annotation-wrap">
      <textarea
        ref={taRef}
        className="annotation nodrag nowheel"
        value={data.text || ''}
        placeholder="Adding your own thoughts here, type type type"
        onChange={onChange}
      />
      <button className="card-close nodrag" onClick={remove} title="Remove note" aria-label="Remove note">
        <CloseIcon />
      </button>
    </div>
  );
}

// ── Image seed card ──────────────────────────────────────────────────────────

/**
 * A plain, uncaptioned image tile — deliberately the most restricted card
 * type in the system (UX_SPEC.md §13). Draggable, and that's the entire
 * interaction surface: no click handler, no menu, no highlighting (no text
 * to highlight), no hover-revealed delete or Expand, no tooltip, no Handle
 * (nothing ever spawns from or connects to an image card). A click on one
 * still bubbles up to Canvas's onNodeClick, which — since this isn't type
 * 'branch' — closes whatever else was selected, exactly like a click on
 * blank canvas would; nothing image-specific is needed for that.
 */
function ImageNode({ data }) {
  return (
    <div className="image-node">
      <img src={data.src} alt="" draggable={false} />
    </div>
  );
}

// Defined once, outside the component: React Flow re-mounts every node if this
// object identity changes between renders.
const nodeTypes = { card: CardNode, branch: BranchNode, annotation: AnnotationNode, image: ImageNode };

// ── Tray ──────────────────────────────────────────────────────────────────────

function Tray({ seeds, onDragStart, onDragEnd, draggingId }) {
  const [open, setOpen] = useState(true);

  return (
    <div className={`tray${open ? '' : ' tray--collapsed'}`}>
      <div className="tray-head">
        <span className="tray-title">Seeds</span>
        <button
          className="tray-toggle"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse' : 'Expand'}
        >
          {open ? '−' : '+'}
        </button>
      </div>

      {open && (
        <div className="tray-body nowheel">
          {seeds.length ? (
            seeds.map((seed) =>
              seed.kind === 'image' ? (
                <div
                  key={seed.id}
                  className={`seed seed--image${draggingId === seed.id ? ' seed--dragging' : ''}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, seed)}
                  onDragEnd={onDragEnd}
                >
                  <img src={seed.src} alt="" draggable={false} />
                </div>
              ) : (
                <div
                  key={seed.id}
                  className={`seed${draggingId === seed.id ? ' seed--dragging' : ''}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, seed)}
                  onDragEnd={onDragEnd}
                  title={seed.sources || ''}
                >
                  {seed.text}
                </div>
              ),
            )
          ) : (
            <p className="tray-empty">All planted. Reload for another ten.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Canvas ────────────────────────────────────────────────────────────────────

/** True when `target` is blank canvas — not a node, panel, control, or edge. */
function isBlankTarget(target) {
  return !(
    target.closest?.('.react-flow__node') ||
    target.closest?.('.react-flow__panel') ||
    target.closest?.('.react-flow__controls') ||
    target.closest?.('.react-flow__edge') ||
    target.closest?.('.plus-btn')
  );
}

async function postJSON(url, body) {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  } catch (e) {
    return { error: e.message };
  }
}

function Canvas({ initialSeeds }) {
  const [seeds, setSeeds] = useState(initialSeeds);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [draggingId, setDraggingId] = useState(null);
  const { screenToFlowPosition } = useReactFlow();
  const nextId = useRef(0);

  // ── Global selection state (UX_SPEC.md §1) ─────────────────────────────────
  const [selectedId, setSelectedId] = useState(null);
  const [snippet, setSnippetState] = useState(null); // {cardId,field,start,end,text} | null
  const [busyId, setBusyId] = useState(null);

  // Always-current mirrors, read inside stable callbacks below so those
  // callbacks don't need to be recreated (and re-passed to every node) on
  // every state change.
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  const snippetRef = useRef(snippet);
  useEffect(() => { snippetRef.current = snippet; }, [snippet]);

  // Guards the "mouseup that just made a highlight is immediately followed by
  // a click on the same element" case (UX_SPEC.md §6, last paragraph) — that
  // click must not be treated as a plain click that resets scope back to
  // whole-card, or it would instantly wipe the snippet just set.
  const justHighlightedRef = useRef(false);

  const activateSnippet = useCallback((cardId, field, start, end, text) => {
    justHighlightedRef.current = true;
    setSelectedId(cardId);
    setSnippetState({ cardId, field, start, end, text });
  }, []);

  const clearSnippet = useCallback(() => setSnippetState(null), []);

  /** Moves a provisional snippet into its card's permanent highlight set. */
  const confirmSnippet = useCallback((scoped) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== scoped.cardId) return n;
      const highlights = n.data.highlights || { title: [], body: [] };
      const list = highlights[scoped.field] || [];
      return {
        ...n,
        data: {
          ...n.data,
          highlights: {
            ...highlights,
            [scoped.field]: mergeRanges([...list, { start: scoped.start, end: scoped.end }]),
          },
        },
      };
    }));
    clearSnippet();
  }, [setNodes, clearSnippet]);

  const onDragStart = useCallback((event, seed) => {
    // The whole seed rather than its id, so the drop can build a node without
    // reaching back into tray state.
    event.dataTransfer.setData(MIME, JSON.stringify(seed));
    event.dataTransfer.effectAllowed = 'move';
    setDraggingId(seed.id);
  }, []);

  const onDragEnd = useCallback(() => setDraggingId(null), []);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();

      const raw = event.dataTransfer.getData(MIME);
      if (!raw) return;
      const seed = JSON.parse(raw);
      // The card's top-left lands where the cursor let go.
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      setNodes((ns) =>
        ns.concat(
          seed.kind === 'image'
            ? { id: `image-${nextId.current++}`, type: 'image', position, data: { src: seed.src } }
            : {
                id: `card-${nextId.current++}`,
                type: 'card',
                position,
                data: {
                  text: seed.text,
                  file: seed.file,
                  passages: seed.passages || [],
                  hasExpanded: false,
                },
              },
        ),
      );

      // A planted seed leaves the tray. Drop this line to let seeds be reused.
      setSeeds((ss) => ss.filter((s) => s.id !== seed.id));
      setDraggingId(null);
    },
    [screenToFlowPosition, setNodes],
  );

  /**
   * Fans `count` new branch cards out from `parentId`, each built by calling
   * `buildCard()` (once per card, in parallel). Shared by Expand, every
   * action pill, and custom questions. Repeated fan-outs from the same
   * parent cascade further right each time, so a run of actions doesn't
   * stack every child in the same spot.
   */
  const spawnChildren = useCallback(async (parentId, { label, labelColor, count, highlightedText, buildCard }) => {
    const parent = nodesRef.current.find((n) => n.id === parentId);
    if (!parent) return;

    const results = await Promise.all(Array.from({ length: count }, () => buildCard()));

    const cascade = parent.data.spawnCount || 0;
    const width = parent.measured?.width ?? (parent.type === 'card' ? CARD_W : BRANCH_W);
    const centreY = parent.position.y + (parent.measured?.height ?? 300) / 2;
    const x = parent.position.x + width + GAP_X + cascade * CASCADE;

    const newNodes = results.map((r, i) => ({
      id: `branch-${nextId.current++}`,
      type: 'branch',
      position: {
        x,
        y: centreY + (i - (results.length - 1) / 2) * GAP_Y - 130,
      },
      data: {
        title: r.title || 'Untitled',
        body: r.body || r.error || '',
        sources: r.sources || [],
        highlightedText: highlightedText || null,
        highlights: { title: [], body: [] },
        parentId,
      },
    }));

    const newEdges = newNodes.map((n) => ({
      id: `edge-${n.id}`,
      source: parentId,
      target: n.id,
      type: 'bezier',
      style: { stroke: '#000', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#000', width: 14, height: 14 },
      ...(label
        ? {
            label,
            labelStyle: { fill: '#000', fontWeight: 700, fontSize: 11 },
            labelBgStyle: { fill: labelColor, stroke: '#000', strokeWidth: 1 },
            labelBgPadding: [6, 3],
            labelBgBorderRadius: 8,
          }
        : {}),
    }));

    setNodes((ns) =>
      ns
        .map((n) => (n.id === parentId ? { ...n, data: { ...n.data, spawnCount: cascade + 1 } } : n))
        .concat(newNodes),
    );
    setEdges((es) => es.concat(newEdges));
  }, [setNodes, setEdges]);

  /** Black card's one-time Expand — fans its real, pre-computed passages. Unlabeled edge: no pill was clicked. */
  const runExpand = useCallback((cardId) => {
    const parent = nodesRef.current.find((n) => n.id === cardId);
    if (!parent || parent.data.hasExpanded) return;

    setNodes((ns) => ns.map((n) => (n.id === cardId ? { ...n, data: { ...n.data, hasExpanded: true } } : n)));

    const passages = parent.data.passages || [];
    if (!passages.length) return;

    let i = -1;
    spawnChildren(cardId, {
      label: null,
      labelColor: null,
      count: passages.length,
      highlightedText: null,
      buildCard: async () => {
        i++;
        const p = passages[i];
        return {
          title: 'Source',
          body: p.text,
          sources: [
            { tag: 'report', name: parent.data.file, citation: p.text },
            ...(p.url ? [{ tag: 'web', name: p.url, citation: p.text }] : []),
          ],
        };
      },
    });
  }, [spawnChildren, setNodes]);

  /** One of the six pills, clicked on a branch card's menu. */
  const runAction = useCallback(async (cardId, actionId) => {
    const action = ACTIONS.find((a) => a.id === actionId);
    const parent = nodesRef.current.find((n) => n.id === cardId);
    if (!action || !parent) return;

    const scoped = snippetRef.current?.cardId === cardId ? snippetRef.current : null;
    const text = scoped ? scoped.text : `${parent.data.title ? parent.data.title + '. ' : ''}${parent.data.body || ''}`.trim();

    setBusyId(cardId);
    try {
      if (actionId === 'evidence') {
        const res = await postJSON('/seed-evidence', { question: text });
        const chunks = res.chunks || [];
        if (!chunks.length) return;
        let i = -1;
        await spawnChildren(cardId, {
          label: action.label,
          labelColor: action.color,
          count: chunks.length,
          highlightedText: scoped?.text || null,
          buildCard: async () => {
            i++;
            const c = chunks[i];
            return { title: c.source || 'Source', body: c.text, sources: [{ tag: 'report', name: c.source, citation: c.text }] };
          },
        });
      } else {
        const question = questionFor(actionId, text);
        await spawnChildren(cardId, {
          label: action.label,
          labelColor: action.color,
          count: action.count,
          highlightedText: scoped?.text || null,
          buildCard: () => postJSON('/seed-generate', { question }),
        });
      }
      if (scoped) confirmSnippet(scoped);
    } finally {
      setBusyId(null);
    }
  }, [spawnChildren, confirmSnippet]);

  /** The free-text "Ask your own question…" input, submitted with Enter. */
  const runCustom = useCallback(async (cardId, userText) => {
    const scoped = snippetRef.current?.cardId === cardId ? snippetRef.current : null;
    const question = scoped ? `${userText} (regarding: "${scoped.text}")` : userText;
    const label = userText.length > 24 ? `${userText.slice(0, 24)}…` : userText;

    setBusyId(cardId);
    try {
      await spawnChildren(cardId, {
        label,
        labelColor: HIGHLIGHT,
        count: 1,
        highlightedText: scoped?.text || null,
        buildCard: () => postJSON('/seed-generate', { question }),
      });
      if (scoped) confirmSnippet(scoped);
    } finally {
      setBusyId(null);
    }
  }, [spawnChildren, confirmSnippet]);

  /**
   * Central click dispatch (UX_SPEC.md §7). Only ever fires on a true click —
   * React Flow already suppresses it during a drag.
   */
  const onNodeClick = useCallback((event, node) => {
    if (justHighlightedRef.current) {
      // This click just finished a text selection; don't also reset scope.
      justHighlightedRef.current = false;
      return;
    }

    if (node.type === 'branch') {
      setSelectedId((cur) => {
        if (cur !== node.id) return node.id;
        return cur; // same card clicked again — falls through to the reset below
      });
      // A fresh click on a different card always starts scoped to the whole
      // card; a repeat click on the already-selected card resets scope back
      // to the whole card too, without closing the menu. Either way: clear.
      clearSnippet();
    } else {
      // Black cards, annotations — clicking anything that isn't the open
      // card's own menu closes whatever was open, same as blank canvas.
      setSelectedId(null);
      clearSnippet();
    }
  }, [clearSnippet]);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
    clearSnippet();
  }, [clearSnippet]);

  const addAnnotation = useCallback((position) => {
    const id = `annotation-${nextId.current++}`;
    setNodes((ns) => ns.concat({ id, type: 'annotation', position, data: { text: '', autoFocus: true } }));
  }, [setNodes]);

  // ── Blank-canvas "+" hover hint + double-click to add a note (§9) ──────────
  const flowRef = useRef(null);
  const [hoverBtn, setHoverBtn] = useState(null); // {x,y,clientX,clientY} | null, container-relative
  const hoverTimerRef = useRef(null);
  const hoverOriginRef = useRef(null);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    hoverOriginRef.current = null;
  };

  const onFlowMouseMove = useCallback((event) => {
    if (!isBlankTarget(event.target)) {
      clearHoverTimer();
      setHoverBtn(null);
      return;
    }
    const { clientX, clientY } = event;
    const origin = hoverOriginRef.current;
    if (origin && Math.hypot(clientX - origin.x, clientY - origin.y) <= 6) return; // resting

    clearHoverTimer();
    setHoverBtn(null);
    hoverOriginRef.current = { x: clientX, y: clientY };
    const rect = flowRef.current.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => {
      setHoverBtn({ x: clientX - rect.left, y: clientY - rect.top, clientX, clientY });
      hoverTimerRef.current = null;
    }, 450);
  }, []);

  const onFlowMouseLeave = useCallback(() => {
    clearHoverTimer();
    setHoverBtn(null);
  }, []);

  const onFlowDoubleClick = useCallback((event) => {
    if (!isBlankTarget(event.target)) return;
    addAnnotation(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    clearHoverTimer();
    setHoverBtn(null);
  }, [addAnnotation, screenToFlowPosition]);

  const onPlusClick = useCallback(() => {
    if (!hoverBtn) return;
    addAnnotation(screenToFlowPosition({ x: hoverBtn.clientX, y: hoverBtn.clientY }));
    setHoverBtn(null);
  }, [hoverBtn, addAnnotation, screenToFlowPosition]);

  const ctx = {
    selectedId, snippet, busyId,
    activateSnippet, runAction, runCustom, runExpand,
  };

  return (
    <SelectionContext.Provider value={ctx}>
      <div
        className="flow"
        ref={flowRef}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onMouseMove={onFlowMouseMove}
        onMouseLeave={onFlowMouseLeave}
        onDoubleClick={onFlowDoubleClick}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          zoomOnDoubleClick={false}
          nodeTypes={nodeTypes}
          minZoom={0.15}
          maxZoom={2.5}
          panOnScroll
          selectionOnDrag
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#d7d7d7" />
          <Controls showInteractive={false} position="bottom-left" />
          <Panel position="top-right" style={{ margin: '16px' }}>
            <Tray
              seeds={seeds}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              draggingId={draggingId}
            />
          </Panel>
        </ReactFlow>

        {hoverBtn && (
          <button
            className="plus-btn"
            style={{ left: hoverBtn.x, top: hoverBtn.y }}
            onClick={onPlusClick}
            title="Add a note"
            aria-label="Add a note"
          >
            +
          </button>
        )}
      </div>
    </SelectionContext.Provider>
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function App() {
  const [seeds, setSeeds] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ok = (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
    Promise.all([
      fetch(`/provocations?n=${SEED_COUNT}`).then(ok),
      // Image seeds are optional — no manifest yet (nobody's run
      // `npm run build:images`) just means an all-text gallery, not an error.
      fetch('/seed-images').then(ok).catch(() => []),
    ])
      .then(([rows, images]) => {
        const textSeeds = rows.map((p, i) => ({ id: `seed-${i}`, ...p }));
        setSeeds(interleaveSeeds(textSeeds, images));
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <p className="status">
        Could not load provocations ({error}).<br />
        Start the server with <code>node rag_web.js serve</code> from <code>js/</code>.
      </p>
    );
  }
  if (!seeds) return <p className="status">Loading provocations…</p>;

  return (
    <ReactFlowProvider>
      <Canvas initialSeeds={seeds} />
    </ReactFlowProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
