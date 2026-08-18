import type { ReactNode } from "react";
import { useObs, type Segment } from "../data/store";
import { Icon } from "../lib/Icon";
import { onTablistKey } from "../lib/tablist";
import { GlobalStats } from "./GlobalStats";
import { useAlerts } from "../monitors/useAlerts";
import { useAlertWebhook } from "../monitors/useAlertWebhook";
import "./AppShell.css";
import "../monitors/monitors.css";

const SEGMENTS: { id: Segment; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "live", label: "Live" },
  { id: "analytics", label: "Analytics" },
  { id: "datasets", label: "Datasets" },
  { id: "monitors", label: "Monitors" },
  { id: "prompts", label: "Prompts" },
  { id: "chat", label: "Chat" },
  { id: "search", label: "Search" },
];
const SEGMENT_IDS = SEGMENTS.map((s) => s.id);

export function AppShell({ children }: { children: ReactNode }) {
  const segment = useObs((s) => s.segment);
  const setSegment = useObs((s) => s.setSegment);
  const setPalette = useObs((s) => s.setPalette);
  const streamStatus = useObs((s) => s.streamStatus);
  const alerts = useAlerts();
  const crit = alerts.filter((a) => a.severity === "crit").length;
  useAlertWebhook(alerts); // deliver new alerts to the configured webhook

  return (
    <>
      <header className="top">
        <span className="mark">
          <svg className="mark-logo" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <rect x="12" y="16" width="40" height="8.5" rx="4.25" fill="#7c6cf2" />
            <rect x="22" y="27.75" width="28" height="8.5" rx="4.25" fill="#4cc9f0" />
            <rect x="16" y="39.5" width="21" height="8.5" rx="4.25" fill="#34d399" />
            <rect x="8.5" y="13" width="2.4" height="38" rx="1.2" fill="#7c6cf2" opacity="0.45" />
          </svg>
          Observe
        </span>
        <nav
          className="seg"
          role="tablist"
          aria-label="Sections"
          onKeyDown={(e) => onTablistKey(e, SEGMENT_IDS, segment, setSegment)}
        >
          {SEGMENTS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={segment === s.id}
              tabIndex={segment === s.id ? 0 : -1}
              className={segment === s.id ? "on" : ""}
              onClick={() => setSegment(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <button className="cmdk" onClick={() => setPalette(true)}>
          <Icon name="search" />
          Jump to run, agent…
          <kbd>⌘K</kbd>
        </button>
        {alerts.length > 0 && (
          <button
            className={`alertchip ${crit ? "" : "warn"}`}
            onClick={() => setSegment("monitors")}
            title={`${alerts.length} alert${alerts.length === 1 ? "" : "s"}${crit ? ` · ${crit} critical` : ""}`}
          >
            <i />
            {alerts.length} alert{alerts.length === 1 ? "" : "s"}
          </button>
        )}
        <span className={`livechip ${streamStatus}`}>
          <i />
          {streamStatus === "open" ? "streaming" : streamStatus === "retrying" ? "reconnecting" : "offline"}
        </span>
      </header>
      <GlobalStats />
      <main className="stage">{children}</main>
    </>
  );
}
