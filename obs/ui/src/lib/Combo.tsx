import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./Combo.css";

export interface ComboOption {
  value: string;
  label: string;
  sub?: string;
}

// A filterable dropdown — scales past the ~30-item point where a native
// <select> gets unwieldy, and matches the app's dark combobox styling. The
// input shows the current label when closed; focusing it opens the list and
// typing filters.
export function Combo({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  width,
}: {
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string; // accessible name (falls back to placeholder) — the input has no visible <label>
  width?: number | string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value) ?? null;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => (o.label + " " + (o.sub ?? "") + " " + o.value).toLowerCase().includes(needle));
  }, [options, q]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // keep the highlighted row visible as arrows move past the fold
  useEffect(() => {
    if (open) activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (o: ComboOption) => {
    onChange(o.value);
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
  };

  return (
    <div className="cmb" ref={wrapRef} style={{ width }}>
      <input
        ref={inputRef}
        className="cmb-input"
        role="combobox"
        aria-label={ariaLabel ?? placeholder}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        value={open ? q : selected?.label ?? ""}
        placeholder={placeholder}
        readOnly={options.length <= 1}
        onFocus={() => {
          if (options.length > 1) {
            setOpen(true);
            setActive(Math.max(0, shown.findIndex((o) => o.value === value)));
          }
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[active]) pick(shown[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      {open && (
        <div className="cmb-list" role="listbox" id={listId}>
          {shown.length === 0 && <div className="cmb-empty">no matches</div>}
          {shown.map((o, i) => (
            <button
              key={o.value}
              ref={i === active ? activeItemRef : undefined}
              type="button"
              role="option"
              id={`${listId}-${i}`}
              aria-selected={i === active}
              className={`cmb-item ${i === active ? "active" : ""} ${o.value === value ? "cur" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              <span className="cmb-check">{o.value === value ? "✓" : ""}</span>
              <span className="cmb-label">{o.label}</span>
              {o.sub && <span className="cmb-sub mono">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
