import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useObs } from "../data/store";
import { api } from "../data/client";
import { useLiveSessions } from "../data/queries";
import { runningDispatches } from "../data/derive/dispatchState";
import { renderMarkdown } from "./markdown";
import type { ChatEvent, ChatMessage, ChatSession } from "../data/types";
import { Icon } from "../lib/Icon";
import { formatCost } from "../lib/format";
import "./chat.css";

const mid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ---- module-level in-flight registry ---------------------------------------
// Each streaming turn's abort handle lives OUTSIDE the component so that
// unmounting the view (switching segments) then remounting restores the
// busy/Stop affordance for that chat and still blocks a concurrent turn into
// it. The stream itself keeps running detached — its terminal commit goes to
// the store, which works whether or not this view is mounted.
//
// Keyed BY CHAT, not a single slot: chats stream independently, so starting a
// turn in chat B must not orphan chat A's controller (which would leave A
// streaming with no way to stop it).
type Inflight = { chatId: string; ctrl: AbortController };
let inflight = new Map<string, Inflight>();
const inflightSubs = new Set<() => void>();
const getInflight = () => inflight;
const notifyInflight = () => {
  // hand useSyncExternalStore a NEW map identity so it re-renders
  inflight = new Map(inflight);
  for (const fn of inflightSubs) fn();
};
const setInflight = (chatId: string, v: Inflight | null) => {
  if (v) inflight.set(chatId, v);
  else inflight.delete(chatId);
  notifyInflight();
};
const subscribeInflight = (fn: () => void) => {
  inflightSubs.add(fn);
  return () => {
    inflightSubs.delete(fn);
  };
};

// everything the in-flight turn renders, scoped to the chat that owns it
type LiveTurn = {
  chatId: string;
  stream: string; // in-flight assistant reply
  thinking: string;
  toolRuns: { name: string; running: boolean }[]; // live tool activity
  pendingApproval: { toolCallId: string; name: string; input?: unknown; error?: string } | null;
};

export function ChatView() {
  const chats = useObs((s) => s.chats);
  const selectedChatId = useObs((s) => s.selectedChatId);
  const createChat = useObs((s) => s.createChat);
  const deleteChat = useObs((s) => s.deleteChat);
  const selectChat = useObs((s) => s.selectChat);
  const patchChat = useObs((s) => s.patchChat);
  const appendChatMessage = useObs((s) => s.appendChatMessage);
  const replaceChatMessages = useObs((s) => s.replaceChatMessages);
  const setSegment = useObs((s) => s.setSegment);
  const selectRun = useObs((s) => s.selectRun);
  const setRunTab = useObs((s) => s.setRunTab);

  const chat = chats.find((c) => c.id === selectedChatId) ?? chats[0] ?? null;

  const [input, setInput] = useState("");
  // keyed by chat for the same reason as the inflight registry — two chats can
  // stream at once, and each one's tokens/tools/approval belong to its own view
  const [liveTurns, setLiveTurns] = useState<Map<string, LiveTurn>>(() => new Map());
  // Errors carry the chat they belong to (null = composer-level, e.g. a failed
  // attachment) so a turn that fails in a background chat doesn't post its
  // banner over whichever conversation you happen to be reading.
  const [err, setErr] = useState<{ chatId: string | null; text: string } | null>(null);
  const showErr = err && (err.chatId === null || err.chatId === chat?.id) ? err.text : "";
  const [pendingImages, setPendingImages] = useState<{ id: string; url: string; name: string }[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const inflightTurn = useSyncExternalStore(subscribeInflight, getInflight);
  const threadRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true); // was the reader near the bottom before the last update?
  const prevChatIdRef = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // this chat is streaming right now (survives remounts via the registry)
  const busyHere = !!chat && inflightTurn.has(chat.id);
  // live-turn UI belongs solely to the chat that owns it
  const live = chat ? liveTurns.get(chat.id) ?? null : null;

  // attach a file: images upload to the server (sent to the agent as image
  // content); text files drop into the composer as a fenced block.
  const onAttachFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.type.startsWith("image/")) {
      if (f.size > 8_000_000) {
        setErr({ chatId: null, text: "image too large (>8MB)" });
        return;
      }
      try {
        const img = await api.uploadImage(f);
        setPendingImages((p) => [...p, img]);
        setErr(null);
      } catch {
        setErr({ chatId: null, text: "image upload failed" });
      }
      return;
    }
    if (f.size > 200_000) {
      setErr({ chatId: null, text: "file too large to attach (>200KB)" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const block = `Attached \`${f.name}\`:\n\n\`\`\`\n${text}\n\`\`\`\n`;
      setInput((prev) => (prev.trim() ? `${prev}\n${block}` : block));
    };
    reader.readAsText(f);
  };

  // running totals for the header
  const turns = chat ? chat.messages.filter((m) => m.role === "assistant").length : 0;
  const totalCost = chat ? chat.messages.reduce((a, m) => a + (m.costUsd || 0), 0) : 0;
  const totalTokens = chat ? chat.messages.reduce((a, m) => a + (m.tokens || 0), 0) : 0;

  // while steering a live agent, surface any sub-agents it's currently blocked on
  const lanes = useObs((s) => s.lanes);
  const waiting = useMemo(
    () => (busyHere && chat?.attachedLive ? runningDispatches(lanes.values(), chat.attachedRunId) : []),
    [busyHere, chat?.attachedLive, chat?.attachedRunId, lanes],
  );

  // keep the thread pinned to the latest as messages/stream grow — but only
  // when the reader was already near the bottom (don't yank them back while
  // they scroll up to re-read). Switching chats always jumps to the latest.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const switched = prevChatIdRef.current !== (chat?.id ?? null);
    prevChatIdRef.current = chat?.id ?? null;
    if (switched || nearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight });
      nearBottomRef.current = true;
    }
  }, [chat?.id, chat?.messages.length, liveTurns, busyHere]);

  // patch one chat's live turn in place, leaving every other chat's alone
  const patchTurn = (chatId: string, fn: (lt: LiveTurn) => LiveTurn) =>
    setLiveTurns((m) => {
      const cur = m.get(chatId);
      if (!cur) return m;
      const next = new Map(m);
      next.set(chatId, fn(cur));
      return next;
    });

  // approve/deny a tool the live agent paused on — clear the card only once
  // the server accepts the decision; on failure keep it with an inline error
  const decide = (decision: "allow" | "deny") => {
    if (!live?.pendingApproval || !chat?.attachedSessionId) return;
    const pa = live.pendingApproval;
    const chatId = live.chatId;
    api.chatApprove(chat.attachedSessionId, pa.toolCallId, decision).then(
      () => patchTurn(chatId, (lt) => ({ ...lt, pendingApproval: null })),
      () =>
        patchTurn(chatId, (lt) =>
          lt.pendingApproval?.toolCallId === pa.toolCallId
            ? { ...lt, pendingApproval: { ...lt.pendingApproval, error: "couldn't send the decision — try again" } }
            : lt,
        ),
    );
  };

  const runTurn = (id: string, text: string, opts?: { regen?: boolean; images?: { id: string; url: string; name: string }[] }) => {
    const imgs = opts?.images ?? [];
    if (!opts?.regen)
      appendChatMessage(id, {
        id: mid(),
        role: "user",
        text,
        ts: Date.now(),
        ...(imgs.length ? { images: imgs.map((i) => ({ url: i.url, name: i.name })) } : {}),
      });
    const ctrl = new AbortController();
    setInflight(id, { chatId: id, ctrl });
    setLiveTurns((m) => new Map(m).set(id, { chatId: id, stream: "", thinking: "", toolRuns: [], pendingApproval: null }));
    setErr(null);
    const cur = useObs.getState().chats.find((c) => c.id === id);
    let acc = "";
    let donged = false;
    const tools: string[] = [];
    // this turn owns THIS CHAT's slot until another turn for the same chat takes
    // it over; a superseded turn keeps streaming detached and only commits
    const owns = () => inflight.get(id)?.ctrl === ctrl;
    const patchLive = (fn: (lt: LiveTurn) => LiveTurn) => {
      if (owns()) patchTurn(id, fn);
    };
    const settle = () => {
      if (!owns()) return;
      setInflight(id, null);
      setLiveTurns((m) => {
        if (!m.has(id)) return m;
        const next = new Map(m);
        next.delete(id);
        return next;
      });
    };
    const commit = (extra: Partial<ChatMessage>) =>
      appendChatMessage(id, {
        id: mid(),
        role: "assistant",
        ts: Date.now(),
        text: acc,
        ...(tools.length ? { tools: tools.slice(0, 50) } : {}),
        ...extra,
      });
    const onEvent = (e: ChatEvent) => {
      if (e.type === "token") {
        acc += e.text;
        patchLive((lt) => ({ ...lt, stream: acc }));
      } else if (e.type === "thinking") {
        patchLive((lt) => ({ ...lt, thinking: lt.thinking + e.text }));
      } else if (e.type === "tool") {
        if (e.phase === "start") {
          tools.push(e.name);
          patchLive((lt) => ({ ...lt, toolRuns: [...lt.toolRuns, { name: e.name, running: true }] }));
        } else {
          // close the most recent still-running run of this tool
          patchLive((lt) => {
            for (let i = lt.toolRuns.length - 1; i >= 0; i--) {
              if (lt.toolRuns[i].running && lt.toolRuns[i].name === e.name) {
                const c = [...lt.toolRuns];
                c[i] = { ...c[i], running: false };
                return { ...lt, toolRuns: c };
              }
            }
            return lt;
          });
        }
      } else if (e.type === "approval") {
        patchLive((lt) => ({ ...lt, pendingApproval: { toolCallId: e.toolCallId, name: e.name, input: e.input } }));
      } else if (e.type === "done") {
        donged = true;
        commit({ text: e.text || acc, costUsd: e.costUsd, tokens: e.tokens, model: e.model });
        settle();
      } else if (e.type === "error") {
        donged = true;
        commit({ error: e.error });
        if (owns()) setErr({ chatId: id, text: e.error });
        settle();
      }
    };

    // Attached to a live agent → steer it; otherwise spawn a fresh pi chat turn.
    const imageIds = imgs.map((i) => i.id);
    const p =
      cur?.attachedLive && cur.attachedSessionId
        ? api.chatLiveStream(
            { sessionId: cur.attachedSessionId, text, deliverAs: cur.deliverMode || "followUp", approve: cur.requireApproval, imageIds },
            onEvent,
            ctrl.signal,
          )
        : api.chatStream({ sessionId: id, text, model: cur?.model || undefined, tools: cur?.toolsEnabled, imageIds }, onEvent, ctrl.signal);

    p.catch((e) => {
      // a mid-stream drop (e.g. the server restarted) — keep whatever streamed
      // as a soft interrupted reply; only show an error when nothing arrived.
      if (!donged) {
        if (acc) commit({ stopped: true });
        else commit({ error: String((e as Error)?.message || e) });
      }
    }).finally(() => {
      if (!donged && ctrl.signal.aborted) commit({ stopped: true });
      settle();
    });
  };

  const viewTrace = () => {
    if (!chat?.attachedRunId) return;
    selectRun(chat.attachedRunId);
    setRunTab("trace");
    setSegment("runs");
  };

  // local slash commands — handled here, never sent to the agent. Returns true
  // if it consumed the input.
  const runSlash = (text: string): boolean => {
    if (!chat) return false;
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim().toLowerCase();
    switch (cmd.toLowerCase()) {
      case "clear":
        replaceChatMessages(chat.id, []);
        return true;
      case "attach":
        setAttachOpen(true); // opens the live-agent picker (no-op while already attached)
        return true;
      case "detach":
        patchChat(chat.id, { attachedLive: undefined, attachedRunId: undefined, attachedSessionId: undefined, attachedAgent: undefined, attachedCwd: undefined, attachedTools: undefined });
        return true;
      case "trace":
        viewTrace();
        return true;
      case "approve":
        patchChat(chat.id, { requireApproval: arg !== "off" });
        return true;
      case "steer":
        patchChat(chat.id, { deliverMode: "steer" });
        return true;
      case "queue":
        patchChat(chat.id, { deliverMode: "followUp" });
        return true;
      case "help":
        appendChatMessage(chat.id, {
          id: mid(),
          role: "assistant",
          ts: Date.now(),
          text: "**Commands**\n- `/clear` — clear this conversation\n- `/attach`, `/detach` — bind/unbind a live agent\n- `/trace` — open the attached run's trace\n- `/approve [on|off]` — gate the live agent's risky tools\n- `/steer`, `/queue` — how a message reaches a busy agent",
        });
        return true;
      default:
        return false; // unknown slash → send as a normal message
    }
  };

  const send = (override?: string) => {
    let text = (override ?? input).trim();
    if (!text && pendingImages.length === 0) return;
    if (busyHere) return; // only the chat that's already streaming blocks sending
    if (text.startsWith("/") && runSlash(text)) {
      setInput("");
      return;
    }
    const images = pendingImages;
    if (!text && images.length) text = "(image attached)";
    const id = chat ? chat.id : createChat();
    setInput("");
    setPendingImages([]);
    runTurn(id, text, { images });
  };

  const stop = () => {
    if (chat) inflightTurn.get(chat.id)?.ctrl.abort();
  };

  // image ids are recoverable from the stored url — uploadImage serves every
  // attachment at `<api>/uploads/<id>`, so a regen can re-send the same ids
  const imageIdFromUrl = (url: string): string | null => /\/uploads\/([^/?#]+)$/.exec(url)?.[1] ?? null;
  const lastUserMsg = useMemo(() => {
    const msgs = chat?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return msgs[i];
    return null;
  }, [chat?.messages]);
  const regenBlocked = !!lastUserMsg?.images?.some((im) => !imageIdFromUrl(im.url));

  // re-run the latest user message (dropping the reply it previously produced),
  // re-sending its image attachments via the recovered ids
  const regenerate = () => {
    if (!chat || busyHere || regenBlocked) return;
    const msgs = chat.messages;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== "user") i--;
    if (i < 0) return;
    const src = msgs[i];
    const images = (src.images ?? []).flatMap((im) => {
      const id = imageIdFromUrl(im.url);
      return id ? [{ id, url: im.url, name: im.name ?? "" }] : [];
    });
    replaceChatMessages(chat.id, msgs.slice(0, i + 1));
    runTurn(chat.id, src.text, { regen: true, images });
  };

  const copyMsg = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const exportChat = () => {
    if (!chat || chat.messages.length === 0) return;
    const out: string[] = [`# ${chat.title}`, ""];
    for (const m of chat.messages) {
      if (m.role === "user") {
        out.push("**You:**", "", m.text, "");
      } else {
        const meta = [m.model, m.costUsd ? formatCost(m.costUsd) : "", m.tokens ? `${m.tokens.toLocaleString()} tok` : ""].filter(Boolean).join(" · ");
        out.push(`**Assistant${meta ? ` (${meta})` : ""}:**`, "");
        if (m.tools?.length) out.push(`> tools: ${m.tools.join(", ")}`, "");
        out.push(m.text || (m.error ? `⚠ ${m.error}` : m.stopped ? "_(stopped)_" : ""), "");
      }
    }
    const blob = new Blob([out.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(chat.title || "chat").replace(/[^\w.-]+/g, "-").slice(0, 48)}.md`;
    a.click();
    // Revoking in the same tick races the download in Firefox/Safari (the fetch
    // for the blob hasn't started yet) — hand the URL back on the next turn.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="chcols">
      <div className="chpane">
        <div className="px ph">
          <h2>Chat</h2>
          <button className="chnew" onClick={() => createChat()} title="New chat">
            <Icon name="spark" size={12} /> New
          </button>
        </div>
        <div className="chlist">
          {chats.length === 0 && <div className="empty">No chats yet — start one.</div>}
          {chats.map((c) => (
            <div key={c.id} className={`chitem ${chat?.id === c.id ? "on" : ""}`}>
              <button className="chsel" onClick={() => selectChat(c.id)}>
                <span className="chn">{c.title}</span>
              </button>
              <button className="chx" title="Delete chat" aria-label={`Delete chat "${c.title}"`} onClick={() => deleteChat(c.id)}>
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="chmain">
        {!chat ? (
          <div className="tab-empty">
            <div>
              Start a conversation with pi.
              <br />
              <button className="chnew" onClick={() => createChat()} style={{ marginTop: 12 }}>
                <Icon name="spark" size={12} /> New chat
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="chhd">
              <input
                className="chtitle"
                value={chat.title}
                onChange={(e) => patchChat(chat.id, { title: e.target.value })}
                aria-label="Chat title"
              />
              {turns > 0 && (
                <span className="chtotals mono" title="conversation totals">
                  {turns} turn{turns === 1 ? "" : "s"}
                  {totalCost > 0 ? ` · ${formatCost(totalCost)}` : ""}
                  {totalTokens > 0 ? ` · ${totalTokens.toLocaleString()} tok` : ""}
                </span>
              )}
              {chat.messages.length > 0 && (
                <button className="chexport" title="Export chat as Markdown" onClick={exportChat}>
                  <Icon name="dl" size={13} />
                </button>
              )}
              {chat.attachedLive ? (
                // steering a live agent: model + tools are the agent's own, not ours
                <>
                  <span
                    className="chlivenote"
                    title={
                      chat.attachedTools?.length
                        ? `Live agent's tools: ${chat.attachedTools.join(", ")}`
                        : "This chat steers a live agent — it uses that agent's model and tools."
                    }
                  >
                    {chat.attachedTools?.length
                      ? `uses the live agent’s model · ${chat.attachedTools.length} tools: ${chat.attachedTools.slice(0, 4).join(", ")}${chat.attachedTools.length > 4 ? "…" : ""}`
                      : "uses the live agent’s model & tools"}
                  </span>
                  <div className="chseg" role="group" title="How a message reaches a busy agent">
                    <button
                      className={(chat.deliverMode ?? "followUp") === "followUp" ? "on" : ""}
                      onClick={() => patchChat(chat.id, { deliverMode: "followUp" })}
                    >
                      queue
                    </button>
                    <button
                      className={chat.deliverMode === "steer" ? "on" : ""}
                      onClick={() => patchChat(chat.id, { deliverMode: "steer" })}
                    >
                      interrupt
                    </button>
                  </div>
                  <label className="chtools" title="Pause risky tools (bash/edit/write) for your approval before they run">
                    <input
                      type="checkbox"
                      checked={!!chat.requireApproval}
                      onChange={(e) => patchChat(chat.id, { requireApproval: e.target.checked })}
                    />
                    approve tools
                  </label>
                </>
              ) : (
                <>
                  <input
                    className="chmodel"
                    value={chat.model}
                    onChange={(e) => patchChat(chat.id, { model: e.target.value })}
                    placeholder="model (optional)"
                  />
                  <label className="chtools" title="Enable pi's tools (bash/edit/etc.) — runs with side effects">
                    <input type="checkbox" checked={chat.toolsEnabled} onChange={(e) => patchChat(chat.id, { toolsEnabled: e.target.checked })} />
                    tools
                  </label>
                </>
              )}
            </div>

            <AttachBar chat={chat} open={attachOpen} onOpenChange={setAttachOpen} />

            <div
              className="chthread"
              ref={threadRef}
              onScroll={() => {
                const el = threadRef.current;
                if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {chat.messages.length === 0 && !busyHere && (
                <div className="chempty">
                  <div className="chempty-t">Send a message to begin{chat.attachedLive ? ` — steering ${chat.attachedAgent ?? "the agent"}` : ""}.</div>
                  <div className="chsuggest">
                    {(chat.attachedLive
                      ? ["What are you working on right now?", "Summarize your progress so far", "What's blocking you?"]
                      : ["Explain a concept simply", "Write a small code snippet", "Summarize the text I paste"]
                    ).map((s) => (
                      <button key={s} className="chsugg" onClick={() => send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className="chempty-hint mono">Tip: type / for commands</div>
                </div>
              )}
              {chat.messages.map((m: ChatMessage, idx) => (
                <div className={`chmsg ${m.role}`} key={m.id}>
                  {m.role === "assistant" && m.tools && m.tools.length > 0 && (
                    <ToolChips runs={m.tools.map((n) => ({ name: n, running: false }))} />
                  )}
                  <div className="chbubble">
                    {m.images && m.images.length > 0 && (
                      <div className="chimgs">
                        {m.images.map((im, k) => (
                          <a key={k} href={im.url} target="_blank" rel="noopener noreferrer" title={im.name}>
                            <img className="chimg" src={im.url} alt={im.name || "attachment"} />
                          </a>
                        ))}
                      </div>
                    )}
                    {m.text &&
                      (m.role === "assistant" ? (
                        <div className="chtext chmd" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                      ) : (
                        <div className="chtext">{m.text}</div>
                      ))}
                    {m.stopped && <div className="chstopped">■ stopped</div>}
                    {m.error && <div className="chmerr">⚠ {m.error}</div>}
                  </div>
                  {m.role === "assistant" && (
                    <div className="chmeta mono">
                      {m.model}
                      {m.costUsd != null && m.costUsd > 0 ? ` · ${formatCost(m.costUsd)}` : ""}
                      {m.tokens ? ` · ${m.tokens.toLocaleString()} tok` : ""}
                      <span className="chacts">
                        {m.text && (
                          <button className="chact" title="Copy" onClick={() => copyMsg(m.text)}>
                            <Icon name="copy" size={12} />
                          </button>
                        )}
                        {idx === chat.messages.length - 1 && !busyHere && (
                          <button
                            className="chact"
                            title={regenBlocked ? "Can't regenerate — this turn's image attachments are no longer recoverable" : "Regenerate"}
                            disabled={regenBlocked}
                            onClick={regenerate}
                          >
                            <Icon name="retry" size={12} />
                          </button>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              ))}
              {busyHere && (
                <div className="chmsg assistant">
                  {live?.thinking && <div className="chthink">{live.thinking}</div>}
                  {live && live.toolRuns.length > 0 && <ToolChips runs={live.toolRuns} />}
                  {live?.pendingApproval && (
                    <div className="chapprove">
                      <div className="chapprove-hd">
                        <Icon name="alert" size={12} /> Approve <strong>{live.pendingApproval.name}</strong>?
                      </div>
                      {live.pendingApproval.input != null && (
                        <pre className="chapprove-input">{JSON.stringify(live.pendingApproval.input, null, 2).slice(0, 600)}</pre>
                      )}
                      <div className="chapprove-acts">
                        <button className="chapprove-allow" onClick={() => decide("allow")}>
                          Allow
                        </button>
                        <button className="chapprove-deny" onClick={() => decide("deny")}>
                          Deny
                        </button>
                      </div>
                      {live.pendingApproval.error && <div className="chapprove-err">⚠ {live.pendingApproval.error}</div>}
                    </div>
                  )}
                  {waiting.length > 0 && (
                    <div className="chwait" title={waiting.map((w) => (w.task ? `${w.agent}: ${w.task}` : w.agent)).join("\n")}>
                      <span className="chwait-dot" />
                      {chat?.attachedAgent ?? "agent"} is waiting on{" "}
                      <strong>{waiting.map((w) => w.agent + (w.attempt && w.attempt > 1 ? ` (retry ${w.attempt})` : "")).join(", ")}</strong>
                      <span className="chwait-ell">…</span>
                    </div>
                  )}
                  <div className="chbubble">
                    {live?.stream ? (
                      <div className="chtext chmd" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.stream) }} />
                    ) : (
                      <div className="chtext">
                        <span className="chdots">…</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {showErr && !busyHere && <div className="chmerr global">⚠ {showErr}</div>}
            </div>

            {pendingImages.length > 0 && (
              <div className="chpending">
                {pendingImages.map((im, k) => (
                  <span className="chpend" key={im.id}>
                    <img src={im.url} alt={im.name} />
                    <button title="Remove" onClick={() => setPendingImages((p) => p.filter((_, j) => j !== k))}>
                      <Icon name="x" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="chcomposer">
              <input
                ref={fileRef}
                type="file"
                hidden
                onChange={onAttachFile}
                accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.go,.rs,.css,.html,.yaml,.yml,.toml,.log,.csv,.sh,text/*"
              />
              <button className="chattachbtn" title="Attach an image or text file" onClick={() => fileRef.current?.click()}>
                <Icon name="clip" size={15} />
              </button>
              <textarea
                className="chinput"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Message pi…  (⏎ to send, ⇧⏎ for newline)"
                aria-label="Message"
                rows={2}
              />
              {busyHere ? (
                <button className="chsend chstop" onClick={stop} title="Stop" aria-label="Stop generating">
                  <Icon name="square" size={13} />
                </button>
              ) : (
                <button
                  className="chsend"
                  onClick={() => send()}
                  disabled={!input.trim() && pendingImages.length === 0}
                  title="Send message"
                  aria-label="Send message"
                >
                  <Icon name="send" size={14} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Tool activity for a turn — one chip per tool (with a ×count), a spinner while
 *  any run of that tool is still in flight. Used live (toolRuns) and on the
 *  committed message (m.tools mapped to non-running). */
function ToolChips({ runs }: { runs: { name: string; running: boolean }[] }) {
  const map = new Map<string, { count: number; running: boolean }>();
  const order: string[] = [];
  for (const r of runs) {
    const e = map.get(r.name);
    if (e) {
      e.count++;
      e.running = e.running || r.running;
    } else {
      map.set(r.name, { count: 1, running: r.running });
      order.push(r.name);
    }
  }
  return (
    <div className="chtools-row">
      <Icon name="wrench" size={11} />
      {order.map((n) => {
        const e = map.get(n)!;
        return (
          <span key={n} className={`chtool ${e.running ? "running" : ""}`}>
            {n}
            {e.count > 1 ? ` ×${e.count}` : ""}
          </span>
        );
      })}
    </div>
  );
}

/** Attach a chat to a LIVE agent: every message is steered into that running
 *  session and its reply streams back. Only sessions alive right now are listed
 *  (polled). If an attached session ends, the bar flags it so you can detach.
 *  The picker's open state is owned by ChatView so `/attach` can open it too. */
function AttachBar({ chat, open, onOpenChange }: { chat: ChatSession; open: boolean; onOpenChange: (open: boolean) => void }) {
  const patchChat = useObs((s) => s.patchChat);
  const setSegment = useObs((s) => s.setSegment);
  const selectRun = useObs((s) => s.selectRun);
  const setRunTab = useObs((s) => s.setRunTab);
  const liveQ = useLiveSessions();
  const live = liveQ.data ?? [];

  const viewTrace = () => {
    if (!chat.attachedRunId) return;
    selectRun(chat.attachedRunId);
    setRunTab("trace");
    setSegment("runs");
  };

  const attach = (s: { sessionId: string; runId?: string; agent: string; cwd: string; tools?: string[] }) => {
    patchChat(chat.id, {
      attachedLive: true,
      attachedSessionId: s.sessionId,
      attachedRunId: s.runId,
      attachedAgent: s.agent,
      attachedCwd: s.cwd,
      attachedTools: s.tools,
    });
    onOpenChange(false);
  };
  const detach = () =>
    patchChat(chat.id, {
      attachedLive: undefined,
      attachedRunId: undefined,
      attachedSessionId: undefined,
      attachedAgent: undefined,
      attachedCwd: undefined,
      attachedTools: undefined,
    });

  // keep the captured toolset fresh: a live agent's tools land at boot, which may
  // arrive after you attached — sync when the live session's list changes
  const liveAttached = chat.attachedLive ? live.find((m) => m.sessionId === chat.attachedSessionId) : undefined;
  useEffect(() => {
    if (liveAttached?.tools && JSON.stringify(liveAttached.tools) !== JSON.stringify(chat.attachedTools)) {
      patchChat(chat.id, { attachedTools: liveAttached.tools });
    }
  }, [liveAttached?.tools, chat.attachedTools, chat.id, patchChat]);

  if (chat.attachedLive && chat.attachedSessionId) {
    const stillLive = live.some((m) => m.sessionId === chat.attachedSessionId);
    const proj = chat.attachedCwd ? chat.attachedCwd.split("/").pop() : undefined;
    return (
      <div className={`chattach on ${stillLive ? "" : "ended"}`}>
        <span className={`cha-dot ${stillLive ? "live" : "dead"}`} />
        <span className="cha-agent">{chat.attachedAgent}</span>
        {proj && <span className="cha-run mono">{proj}</span>}
        <span className="cha-note">{stillLive ? "steering live — messages go to this agent" : "session ended — detach to chat normally"}</span>
        {chat.attachedRunId && (
          <button className="cha-trace" title="Open this run's trace" onClick={viewTrace}>
            <Icon name="crosshair" size={11} /> trace
          </button>
        )}
        <button className="cha-x" title="Detach" onClick={detach}>
          <Icon name="x" size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="chattach">
      {!open ? (
        <button className="cha-btn" onClick={() => onOpenChange(true)}>
          <Icon name="crosshair" size={12} /> Attach to a live agent
        </button>
      ) : (
        <div className="cha-pick">
          <div className="cha-hd">
            Live agents{live.length ? ` (${live.length})` : ""}
            <button className="cha-x" onClick={() => onOpenChange(false)}>
              <Icon name="x" size={11} />
            </button>
          </div>
          <div className="cha-list">
            {live.map((m) => (
              <button key={m.sessionId} className="cha-row" onClick={() => attach({ sessionId: m.sessionId, runId: m.runId, agent: m.agent, cwd: m.cwd, tools: m.tools })}>
                <span className="cha-dot live" />
                <span className="cha-rt">{m.agent}</span>
                <span className="cha-rid mono">{m.tools?.length ? `${m.tools.length} tools` : m.cwd.split("/").pop()}</span>
              </button>
            ))}
            {live.length === 0 && <div className="cha-empty">No live agents right now. Start a pi session (with PI_OBS=1) to attach.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
