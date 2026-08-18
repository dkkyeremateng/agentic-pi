// Shimmer placeholders shown while data loads (skill: progressive-loading —
// prefer a skeleton over a blocking spinner/text for >~300ms fetches). The
// shimmer is a background animation, so the global prefers-reduced-motion reset
// (base.css) freezes it to a static block automatically — still communicates
// "loading" via the reserved layout, with no motion.
import "./Skeleton.css";

/** A single shimmer bar. `w`/`h` accept any CSS length; defaults suit a text line. */
export function Skel({ w = "100%", h = 12, r = 6 }: { w?: string | number; h?: string | number; r?: number }) {
  return <span className="skel" style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}

/** Loading state for a run-detail tab body — a few rows of shimmer, so the tab
 *  reserves its space and reads as "loading" rather than flashing empty. */
export function TabSkeleton({ rows = 6, label = "Loading…" }: { rows?: number; label?: string }) {
  return (
    <div className="skel-tab" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i}>
          <Skel w={78} h={11} />
          <Skel w={`${40 + ((i * 37) % 45)}%`} h={11} />
        </div>
      ))}
    </div>
  );
}
