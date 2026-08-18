import { useEffect } from "react";
import { AppShell } from "./shell/AppShell";
import { CommandPalette } from "./shell/CommandPalette";
import { TokenGate } from "./shell/TokenGate";
import { RunsView } from "./runs/RunsView";
import { LiveView } from "./live/LiveView";
import { AnalyticsView } from "./analytics/AnalyticsView";
import { DatasetsView } from "./datasets/DatasetsView";
import { MonitorsView } from "./monitors/MonitorsView";
import { PromptsView } from "./prompts/PromptsView";
import { ChatView } from "./chat/ChatView";
import { SearchView } from "./search/SearchView";
import { useObs } from "./data/store";
import { openStream } from "./data/stream";
import { api } from "./data/client";
import { useUrlSync } from "./data/url";
import type { ObsEvent } from "./data/types";

// Ceiling on the un-flushed stream backlog (see the flusher below). Generous
// enough that a normal pause replays intact — lanes keep only a 60-event tail
// each, so anything beyond this would be discarded on ingest regardless.
const MAX_PENDING = 5000;

export default function App() {
  const segment = useObs((s) => s.segment);
  const setStreamStatus = useObs((s) => s.setStreamStatus);
  const ingestMany = useObs((s) => s.ingestMany);
  const setPalette = useObs((s) => s.setPalette);

  useUrlSync();

  // §4.1–4.3 live stream — connects on mount, survives server restarts.
  // Every event is queued; a ~100ms flusher hands batches to ingestMany, so
  // pausing the wall buffers instead of dropping and unpausing replays the
  // backlog on the next tick. The buffer is CAPPED: a wall left paused against
  // a busy fleet would otherwise grow without bound. Past the cap the oldest
  // events fall off (the wall only ever shows a bounded recent tail anyway).
  useEffect(() => {
    let pending: ObsEvent[] = [];
    const flush = () => {
      if (useObs.getState().livePaused || pending.length === 0) return;
      const batch = pending;
      pending = [];
      ingestMany(batch);
    };
    const timer = setInterval(flush, 100);
    const h = openStream({
      onEvent: (ev) => {
        pending.push(ev);
        if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
      },
      onStatus: setStreamStatus,
    });
    return () => {
      clearInterval(timer);
      h.close();
    };
  }, [ingestMany, setStreamStatus]);

  // adopt server-stored chats on load (survive cache clear / shared across
  // browsers). On the very first run the server is empty — push local up.
  useEffect(() => {
    let cancelled = false;
    api
      .getChats()
      .then(({ chats }) => {
        if (cancelled) return;
        const local = useObs.getState().chats;
        if (chats.length > 0) useObs.getState().hydrateChats(chats);
        else if (local.length > 0) api.putChats(local).catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ⌘K / Ctrl-K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!useObs.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  return (
    <AppShell>
      {segment === "runs" && <RunsView />}
      {segment === "live" && <LiveView />}
      {segment === "analytics" && <AnalyticsView />}
      {segment === "datasets" && <DatasetsView />}
      {segment === "monitors" && <MonitorsView />}
      {segment === "prompts" && <PromptsView />}
      {segment === "chat" && <ChatView />}
      {segment === "search" && <SearchView />}
      <CommandPalette />
      <TokenGate />
    </AppShell>
  );
}
