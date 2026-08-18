import { useState } from "react";
import "./Stepper.css";

// A compact labelled number control with −/+ buttons. Replaces bare
// <input type="number">, whose native spinners render as a light box that
// clashes with the dark theme. The parent owns any unit mapping (e.g. minutes
// ↔ ms); this deals purely in the displayed value. Typing is buffered in a
// draft and committed (clamped) on blur/Enter; an empty or unparseable field
// commits nothing and reverts to the last value.
export function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  width = 56,
  prefix,
}: {
  label?: string; // omit for an inline control (e.g. a table row)
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  prefix?: string; // e.g. "$" shown inside the field
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const decimals = String(step).split(".")[1]?.length ?? 0;
  const round = (n: number) => Number(n.toFixed(decimals));
  const clamp = (n: number) => {
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
  };
  const set = (n: number) => onChange(clamp(round(n)));
  const commitDraft = () => {
    if (draft == null) return;
    setDraft(null);
    if (draft.trim() === "") return; // empty — keep the previous value
    const n = Number(draft);
    if (Number.isFinite(n)) set(n);
  };

  return (
    <label className="stepper">
      {label && <span className="stepper-l">{label}</span>}
      <span className="stepper-box">
        <button type="button" className="stepper-b" aria-label={`decrease ${label ?? "value"}`} disabled={min != null && value <= min} onClick={() => set(value - step)}>
          −
        </button>
        {prefix && <span className="stepper-pfx">{prefix}</span>}
        <input
          type="number"
          value={draft ?? value}
          min={min}
          max={max}
          step={step}
          style={{ width }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
          }}
        />
        <button type="button" className="stepper-b" aria-label={`increase ${label ?? "value"}`} disabled={max != null && value >= max} onClick={() => set(value + step)}>
          +
        </button>
      </span>
    </label>
  );
}
