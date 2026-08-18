import { useEffect, useState } from "react";

// Reactive matchMedia — re-renders when the query's match state flips (e.g.
// crossing the mobile breakpoint), so layout can switch between desktop panes
// and a mobile master→detail flow.
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
