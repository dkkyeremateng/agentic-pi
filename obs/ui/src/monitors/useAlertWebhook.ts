import { useEffect, useState } from "react";
import { api } from "../data/client";
import { useObs } from "../data/store";
import type { Alert } from "../data/derive/monitors";

// One delivery per (monitor, run) — so a breach notifies once, not on every poll.
export const alertKey = (a: Alert) => `${a.monitorId}:${a.runId ?? "agg"}`;

const SENT_KEY = "obs.notifiedAlerts";
const MAX_SENT = 500;
function loadSent(): Set<string> {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}
function saveSent(s: Set<string>) {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify([...s].slice(-MAX_SENT)));
  } catch {
    /* ignore */
  }
}

// Mounted once (AppShell): delivers newly-fired alerts to the configured webhook.
// Dedupes via localStorage so reloads don't re-send. Fires only while the
// dashboard is open — a server-resident monitor loop would be the next step.
// Takes `alerts` from the caller rather than calling useAlerts() itself: the
// shell already needs them for the header badge, and evaluateMonitors is O(runs
// × monitors) with a per-run evaluateRun, so computing it twice is pure waste.
export function useAlertWebhook(alerts: Alert[]) {
  const enabled = useObs((s) => s.webhook.enabled);
  const rawUrl = useObs((s) => s.webhook.url);
  // Debounce the URL so typing in the settings field doesn't relay real alert
  // payloads to every partial URL along the way.
  const [url, setUrl] = useState(rawUrl);
  useEffect(() => {
    const t = setTimeout(() => setUrl(rawUrl), 500);
    return () => clearTimeout(t);
  }, [rawUrl]);
  useEffect(() => {
    if (!enabled || !alerts.length) return;
    // Only a well-formed http(s) URL is worth a delivery attempt — anything
    // else (partial input mid-edit, odd schemes) is silently skipped.
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return;
    }
    if (protocol !== "http:" && protocol !== "https:") return;
    // Re-read the dedupe set at the last moment: another tab may have delivered
    // some of these since our last look (best-effort — localStorage is no lock).
    const sent = loadSent();
    const fresh = alerts.filter((a) => !sent.has(alertKey(a)));
    if (!fresh.length) return;
    // optimistic dedupe so a re-render mid-flight doesn't double-send
    fresh.forEach((a) => sent.add(alertKey(a)));
    saveSent(sent);
    const payload = {
      source: "pi-obs",
      ts: Date.now(),
      count: fresh.length,
      alerts: fresh.map((a) => ({
        monitor: a.monitorName,
        metric: a.metric,
        severity: a.severity,
        runId: a.runId,
        detail: a.detail,
        value: a.value,
        threshold: a.threshold,
      })),
    };
    api
      .notify(url, payload)
      .then((r) => {
        // the relay answers HTTP 200 with ok:false when the TARGET failed —
        // that's still a failed delivery, not a success
        if (!r.ok) throw new Error(r.error || String(r.status ?? "delivery failed"));
      })
      .catch(() => {
        // delivery failed — drop the keys so a later tick retries
        const retry = loadSent();
        fresh.forEach((a) => retry.delete(alertKey(a)));
        saveSent(retry);
      });
  }, [alerts, enabled, url]);
}
