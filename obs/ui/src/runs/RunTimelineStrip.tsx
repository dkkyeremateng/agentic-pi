// v3 transplant — verdict-colored run blocks over real time, as the inbox
// header. Glance navigation for "what happened today". Brush is a later
// refinement; for now blocks are clickable and the selected one is outlined.
import type { RunMeta } from "../data/types";
import { statusOf } from "./runUtils";

const WINDOW_MS = 6 * 60 * 60 * 1000; // -6h … now

export function RunTimelineStrip({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const now = Date.now();
  const start = now - WINDOW_MS;
  const blocks = runs
    .filter((r) => r.lastTs >= start)
    .map((r) => {
      const left = ((Math.max(r.firstTs, start) - start) / WINDOW_MS) * 100;
      const width = Math.max(1.2, ((r.lastTs - Math.max(r.firstTs, start)) / WINDOW_MS) * 100);
      return { r, left, width, status: statusOf(r, now) };
    });

  return (
    <div className="strip">
      <div className="sl">
        <span>-6h</span>
        <span>-3h</span>
        <span>now</span>
      </div>
      <div className="srail">
        {blocks.map(({ r, left, width, status }) => (
          <button
            key={r.runId}
            title={r.runId}
            className={`sb ${status === "live" ? "lv" : status === "fail" ? "er" : "ok"} ${
              r.runId === selectedId ? "sel" : ""
            }`}
            style={{ left: `${left}%`, width: `${width}%` }}
            onClick={() => onSelect(r.runId)}
          />
        ))}
      </div>
    </div>
  );
}
