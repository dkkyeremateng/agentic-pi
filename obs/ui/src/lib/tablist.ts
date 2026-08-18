// Arrow-key navigation for an ARIA tablist (WAI-ARIA tabs pattern): ←/→ move
// between tabs (wrapping), Home/End jump to the ends, and DOM focus follows the
// selection. Pair with roving tabindex on the tabs (0 for the selected tab, -1
// for the rest) so Tab lands on the active tab and arrows move within the group.
import type { KeyboardEvent } from "react";

export function onTablistKey<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  ids: readonly T[],
  current: T,
  select: (id: T) => void,
): void {
  let n = ids.indexOf(current);
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (n - 1 + ids.length) % ids.length;
  else if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (n + 1) % ids.length;
  else if (e.key === "Home") n = 0;
  else if (e.key === "End") n = ids.length - 1;
  else return;
  e.preventDefault();
  select(ids[n]);
  const tabs = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs[n]?.focus();
}
