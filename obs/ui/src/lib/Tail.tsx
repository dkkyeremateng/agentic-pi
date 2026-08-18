// Shared "tail" behaviour for the live feeds (Events rows, Trace spans): pin a
// scroll container to its newest item as items arrive, pause the moment the
// reader scrolls away, and count what landed while they were reading back.
import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";

// How close to the bottom still counts as "at the live edge". Wide enough to
// survive sub-pixel rounding and a partially-visible last row.
const AT_BOTTOM_PX = 48;

export interface Tail {
  /** attach to the scrolling container */
  ref: RefCallback<HTMLDivElement>;
  /** attach to the same container's onScroll */
  onScroll: () => void;
  following: boolean;
  /** items that arrived since the reader left the live edge (0 while following) */
  behind: number;
  jumpToLatest: () => void;
  pause: () => void;
}

export function useTail(
  count: number,
  opts: {
    /** changing this re-anchors to the live edge (e.g. a different run) */
    resetKey?: unknown;
    /** changing this re-runs the pin without resetting state (e.g. a filter
     *  that changes the rendered height) */
    layoutKey?: unknown;
    /** return true while something else owns the scroll position — a
     *  cross-page jump, say — so the tail doesn't fight it */
    skip?: () => boolean;
  } = {},
): Tail {
  const { resetKey, layoutKey, skip } = opts;
  const ref = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [behind, setBehind] = useState(0);
  const seenRef = useRef(0); // count as of the last time we sat at the bottom
  // read through refs so a caller passing an inline closure doesn't retrigger
  // the pin effect, and so the observer below always sees current state
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const followingRef = useRef(following);
  followingRef.current = following;

  const pin = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // A callback ref (not a plain one) so the observer attaches the moment the
  // container mounts — these tabs render a skeleton first, so the node isn't
  // there on the first commit.
  //
  // The observer is what makes the pin reliable: a tab can mount before its
  // container has been laid out, and pinning against a zero-height box is a
  // no-op that never retries (the item count isn't changing on a finished
  // run). Re-pinning on resize closes that race.
  const observerRef = useRef<ResizeObserver | null>(null);
  const attach = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      ref.current = node;
      if (!node || typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(() => {
        if (followingRef.current && !skipRef.current?.()) node.scrollTop = node.scrollHeight;
      });
      ro.observe(node);
      observerRef.current = ro;
    },
    [],
  );

  useEffect(() => {
    setFollowing(true);
    setBehind(0);
    seenRef.current = 0;
  }, [resetKey]);

  useEffect(() => {
    if (!ref.current || skipRef.current?.()) return;
    if (following) {
      pin();
      seenRef.current = count;
      setBehind(0);
    } else {
      setBehind(Math.max(0, count - seenRef.current));
    }
  }, [count, following, layoutKey, pin]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    setFollowing(atBottom);
    if (atBottom) {
      seenRef.current = count;
      setBehind(0);
    }
  }, [count]);

  const jumpToLatest = useCallback(() => {
    pin();
    setFollowing(true);
  }, [pin]);

  const pause = useCallback(() => setFollowing(false), []);

  return { ref: attach, onScroll, following, behind, jumpToLatest, pause };
}

/** The tail's state as a clickable chip: following ⇄ paused (with a count of
 *  what arrived meanwhile). */
export function TailChip({ tail, noun = "event" }: { tail: Tail; noun?: string }) {
  const { following, behind, jumpToLatest, pause } = tail;
  return (
    <button
      className={`tailchip ${following ? "on" : ""}`}
      onClick={() => (following ? pause() : jumpToLatest())}
      title={
        following
          ? `Following new ${noun}s — click to pause`
          : `Paused — click to jump to the newest ${noun}`
      }
      aria-pressed={following}
    >
      <i />
      {following ? "following" : behind > 0 ? `${behind.toLocaleString()} new` : "paused"}
    </button>
  );
}
