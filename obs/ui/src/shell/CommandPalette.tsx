import { useEffect, useMemo, useRef, useState } from "react";
import { useObs, type Segment } from "../data/store";
import { useRuns } from "../data/queries";
import { runTitle } from "../runs/runUtils";
import { Icon } from "../lib/Icon";
import "./CommandPalette.css";

type Item =
  | { kind: "segment"; id: Segment; label: string }
  | { kind: "run"; id: string; label: string; sub: string };

const SEGMENT_ITEMS: Item[] = [
  { kind: "segment", id: "runs", label: "Go to Runs" },
  { kind: "segment", id: "live", label: "Go to Live" },
  { kind: "segment", id: "analytics", label: "Go to Analytics" },
  { kind: "segment", id: "datasets", label: "Go to Datasets" },
  { kind: "segment", id: "monitors", label: "Go to Monitors" },
  { kind: "segment", id: "prompts", label: "Go to Prompts" },
  { kind: "segment", id: "chat", label: "Go to Chat" },
  { kind: "segment", id: "search", label: "Go to Search" },
];

export function CommandPalette() {
  const open = useObs((s) => s.paletteOpen);
  const setPalette = useObs((s) => s.setPalette);
  const setSegment = useObs((s) => s.setSegment);
  const selectRun = useObs((s) => s.selectRun);
  const runsQ = useRuns();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const items = useMemo<Item[]>(() => {
    const runItems: Item[] = (runsQ.data ?? []).map((r) => ({
      kind: "run",
      id: r.runId,
      label: runTitle(r),
      sub: r.runId,
    }));
    const all = [...SEGMENT_ITEMS, ...runItems];
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 30);
    return all
      .filter(
        (it) =>
          it.label.toLowerCase().includes(needle) ||
          (it.kind === "run" && it.sub.toLowerCase().includes(needle)),
      )
      .slice(0, 30);
  }, [runsQ.data, q]);

  useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setQ("");
    setActive(0);
    queueMicrotask(() => inputRef.current?.focus());
    // on close, hand focus back to whatever opened the palette (⌘K button, etc.)
    return () => {
      prevFocusRef.current?.focus();
      prevFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => setActive(0), [q]);
  // keep the highlighted row visible as arrows move past the fold
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function choose(it: Item) {
    if (it.kind === "segment") setSegment(it.id);
    else {
      setSegment("runs");
      selectRun(it.id);
    }
    setPalette(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) choose(it);
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={() => setPalette(false)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") setPalette(false);
        }}
      >
        <div className="palette-input">
          <Icon name="search" size={16} style={{ color: "var(--t3)" }} />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={items.length > 0 ? `palette-opt-${active}` : undefined}
            value={q}
            placeholder="Jump to run, agent, or section…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" role="listbox" id="palette-listbox">
          {items.length === 0 && <div className="palette-empty">No matches.</div>}
          {items.map((it, i) => (
            <button
              key={it.kind + it.id}
              ref={i === active ? activeRef : undefined}
              role="option"
              id={`palette-opt-${i}`}
              aria-selected={i === active}
              className={`palette-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(it)}
            >
              <span className={`pi-kind ${it.kind === "run" ? "k-run" : "k-seg"}`}>
                {it.kind === "run" ? "RUN" : "GO"}
              </span>
              <span className="pi-label">{it.label}</span>
              {it.kind === "run" && <span className="pi-sub mono">{it.sub}</span>}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>⏎</kbd> open</span>
          <span className="pf-sep">on Runs:</span>
          <span><kbd>j</kbd><kbd>k</kbd> prev / next run</span>
          <span><kbd>1</kbd>–<kbd>6</kbd> switch tab</span>
        </div>
      </div>
    </div>
  );
}
