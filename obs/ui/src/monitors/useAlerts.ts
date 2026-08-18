import { useMemo } from "react";
import { useRuns } from "../data/queries";
import { useObs } from "../data/store";
import { evaluateMonitors, type Alert } from "../data/derive/monitors";

// Live alerts from the active monitors over the indexed runs — shared by the
// Monitors view and the header badge so both agree on the count.
export function useAlerts(): Alert[] {
  const runs = useRuns().data ?? [];
  const monitors = useObs((s) => s.monitors);
  const cfg = useObs((s) => s.evalConfig);
  return useMemo(() => evaluateMonitors(monitors, runs, cfg), [monitors, runs, cfg]);
}
