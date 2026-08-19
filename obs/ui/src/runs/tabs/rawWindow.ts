// render cap — huge runs would otherwise mount tens of thousands of <pre>s.
// "Show all" lifts it (copy always covers the full filtered set).
export const ROW_CAP = 500;

// The cap keeps the NEWEST rows (slice from the end): this is a tail, so the
// live edge must stay rendered — capping from the front would freeze the feed
// at the run's first 500 rows and hide every event that arrives after.
export function tailWindow<T>(rows: T[], showAll: boolean): { visible: T[]; hidden: number } {
  if (showAll || rows.length <= ROW_CAP) return { visible: rows, hidden: 0 };
  return { visible: rows.slice(-ROW_CAP), hidden: rows.length - ROW_CAP };
}
