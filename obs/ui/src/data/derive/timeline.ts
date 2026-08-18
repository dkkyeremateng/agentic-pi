// Pure geometry for the Timeline gantt's zoom + replay. A "view" is the
// currently-visible time window inside the run bounds; bars are projected into
// it (clipped), and replay reveals the portion of each bar up to a playhead.

export interface View {
  start: number;
  end: number;
}

export const MIN_SPAN_MS = 200; // don't let zoom go tighter than this

export function fullView(runStart: number, runEnd: number): View {
  return { start: runStart, end: Math.max(runStart + 1, runEnd) };
}

export function fracToTs(frac: number, win: View): number {
  return win.start + frac * (win.end - win.start);
}

export function tsToFrac(ts: number, win: View): number {
  const span = Math.max(1, win.end - win.start);
  return (ts - win.start) / span;
}

/** A bar [startTs,endTs] projected into the view, clipped to [0,1].
 *  `visible` is false when the bar is entirely outside the window. */
export function viewBar(
  startTs: number,
  endTs: number,
  view: View,
): { left: number; width: number; visible: boolean } {
  const span = Math.max(1, view.end - view.start);
  const l = (startTs - view.start) / span;
  const r = (endTs - view.start) / span;
  const left = Math.min(1, Math.max(0, l));
  const right = Math.min(1, Math.max(0, r));
  return { left, width: Math.max(0, right - left), visible: r > 0 && l < 1 };
}

/** The revealed portion of a bar during replay: start … min(end, playhead). */
export function revealBar(
  startTs: number,
  endTs: number,
  view: View,
  playhead: number,
): { left: number; width: number } {
  const cappedEnd = Math.min(endTs, playhead);
  if (cappedEnd <= startTs) {
    const b = viewBar(startTs, startTs, view);
    return { left: b.left, width: 0 };
  }
  const b = viewBar(startTs, cappedEnd, view);
  return { left: b.left, width: b.width };
}

/** Keep a candidate view inside the run bounds and no tighter than MIN_SPAN. */
export function clampView(view: View, bounds: View): View {
  const fullSpan = Math.max(MIN_SPAN_MS, bounds.end - bounds.start);
  let span = Math.min(Math.max(MIN_SPAN_MS, view.end - view.start), fullSpan);
  let start = view.start;
  if (start < bounds.start) start = bounds.start;
  if (start + span > bounds.end) start = bounds.end - span;
  if (start < bounds.start) {
    start = bounds.start;
    span = Math.min(span, bounds.end - bounds.start);
  }
  return { start, end: start + span };
}

/** Evenly spaced tick timestamps across the view (caller formats the labels). */
export function axisTicks(view: View, n = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(fracToTs(i / (n - 1), view));
  return out;
}

export function isZoomed(view: View, bounds: View): boolean {
  return view.end - view.start < bounds.end - bounds.start - 1;
}
