// ── race view (turn-normalized) ──────────────────────────────────────────────
function bucketByTurn(a) {
    let cur = -1;
    const setup = [];
    const turns = new Map();
    let maxTurn = -1;
    for (const ev of a.events) {
        const idx = ev.payload && ev.payload.turnIndex;
        let ti;
        if (ev.type === "turn_start") {
            cur = idx != null ? idx : cur + 1;
            ti = cur;
        } else if (ev.type === "turn_end") {
            ti = idx != null ? idx : cur;
        } else {
            ti = cur;
        }
        if (ti < 0) {
            setup.push(ev);
            continue;
        }
        if (!turns.has(ti)) turns.set(ti, []);
        turns.get(ti).push(ev);
        if (ti > maxTurn) maxTurn = ti;
    }
    return { setup, turns, maxTurn, turnsReached: turns.size };
}

// Emoji marker per event type (in the spirit of disler's symbol set).
function emojiFor(ev) {
    switch (ev.type) {
        case "session_start":
            return "🚀";
        case "boot":
            return "🧰";
        case "session_end":
            return "🏁";
        case "turn_start":
            return "▶️";
        case "turn_end":
            return "⏹️";
        case "tool_start":
            return "🔧";
        case "tool_end":
            return ev.payload && ev.payload.isError ? "❌" : "✅";
        case "model_change":
            return "🔁";
        case "dispatch_start":
            return "📤";
        case "dispatch_retry":
            return "🔁";
        case "dispatch_end":
            return ev.payload && ev.payload.status === "error" ? "❌" : "📥";
        case "compaction":
            return "📦";
        case "error":
            return "❌";
        case "message":
            return (ev.payload && ev.payload.kind) === "thinking"
                ? "💭"
                : (ev.payload && ev.payload.kind) === "user"
                  ? "👤"
                  : "💬";
        default:
            return "•";
    }
}

function typeLabel(ev) {
    switch (ev.type) {
        case "session_start":
            return "start";
        case "session_end":
            return "end";
        case "turn_start":
            return "turn start";
        case "turn_end":
            return "turn end";
        case "tool_start":
            return "tool call";
        case "tool_end":
            return "tool result";
        case "model_change":
            return "model";
        case "dispatch_start":
            return "dispatch start";
        case "dispatch_retry":
            return "dispatch retry";
        case "dispatch_end":
            return "dispatch end";
        case "message": {
            const k = ev.payload && ev.payload.kind;
            return k === "thinking"
                ? "thinking"
                : k === "user"
                  ? "user message"
                  : "assistant message";
        }
        default:
            return ev.type;
    }
}

// A short prompt/snippet for a turn (its first assistant/thinking/user text).
function turnSnippet(evs) {
    for (const ev of evs) {
        if (ev.type === "message" && ev.payload && ev.payload.text)
            return ev.payload.text.replace(/\s+/g, " ").trim();
    }
    return "";
}

const raceScroll = new Map(); // laneKey -> scrollLeft of its .race-turns

// Event inspector (bottom dock) — full detail for a clicked event.
function openInspector(ev, lane) {
    $("insp-type").textContent = emojiFor(ev) + "  " + typeLabel(ev);
    $("insp-agent").textContent =
        (lane ? lane.label : ev.agent) +
        (lane && lane.project ? " · " + lane.project : "");
    $("insp-time").textContent = clock(ev.ts);
    $("insp-seq").textContent = "#" + ev.seq;
    $("insp-typ2").textContent = typeLabel(ev);
    $("insp-summary").textContent = describe(ev).detail;
    $("insp-json").textContent = JSON.stringify(ev, null, 2);
    $("inspector").classList.add("open");
}
function closeInspector() {
    $("inspector").classList.remove("open");
}

function raceEventCard(ev, lane) {
    const { kls, detail } = describe(ev);
    const card = document.createElement("div");
    card.className = "race-event " + kls;
    card.addEventListener("click", () => openInspector(ev, lane));
    const head = document.createElement("div");
    head.className = "ev-head";
    const em = document.createElement("span");
    em.className = "emoji";
    em.textContent = emojiFor(ev);
    const ty = document.createElement("span");
    ty.className = "ev-type";
    ty.textContent = typeLabel(ev);
    head.append(em, ty);
    if (
        (ev.type === "tool_start" || ev.type === "tool_end") &&
        ev.payload &&
        ev.payload.toolName
    ) {
        const tool = document.createElement("span");
        tool.className = "ev-tool";
        tool.textContent = ev.payload.toolName;
        tool.title = ev.payload.toolName;
        head.append(tool);
    }
    const sum = document.createElement("div");
    sum.className = "ev-summary";
    sum.textContent = detail;
    const time = document.createElement("div");
    time.className = "ev-time";
    time.textContent = clock(ev.ts) + " · #" + ev.seq;
    card.append(head, sum, time);
    return card;
}

function renderRace() {
    const tracks = $("race-tracks");
    const list = [...lanes.values()].filter(
        (a) => a.events.length && laneVisible(a),
    );
    if (!list.length) {
        $("race-empty").style.display = "block";
        tracks.innerHTML = "";
        $("race-axis").textContent = "";
        return;
    }
    $("race-empty").style.display = "none";

    // capture current scroll positions before rebuild
    tracks.querySelectorAll(".race-turns").forEach((el) => {
        if (el.dataset.key) raceScroll.set(el.dataset.key, el.scrollLeft);
    });

    let maxTurn = -1;
    let running = 0;
    let leader = null;
    const buckets = new Map();
    for (const a of list) {
        const b = bucketByTurn(a);
        buckets.set(a.key, b);
        if (b.maxTurn > maxTurn) maxTurn = b.maxTurn;
        if (a.rollup.active) running++;
        if (!leader || b.turnsReached > buckets.get(leader.key).turnsReached)
            leader = a;
    }
    $("race-axis").innerHTML =
        "turns <b>0–" +
        Math.max(0, maxTurn) +
        "</b> · agents <b>" +
        list.length +
        "</b>" +
        (leader ? " · leader <b>" + leader.agent + "</b>" : "") +
        (running ? " · <b>" + running + "</b> running" : "");

    const sorted = [...list].sort(
        (x, y) => (x.events[0]?.ts || 0) - (y.events[0]?.ts || 0),
    );

    tracks.innerHTML = "";
    for (const a of sorted) {
        const b = buckets.get(a.key);
        const cols = [];
        if (b.setup.length) cols.push(-1);
        for (let i = 0; i <= b.maxTurn; i++) cols.push(i);
        // active turn: follow the latest unless the user pinned one or zoomed
        // out (activeTurn === null means all turns collapsed).
        if (a.followLatest !== false) a.activeTurn = b.maxTurn;
        else if (a.activeTurn === undefined) a.activeTurn = b.maxTurn;

        const track = document.createElement("div");
        track.className = "race-track" + (a.rollup.active ? " active" : "");

        // agent card
        const agent = document.createElement("div");
        agent.className = "race-agent";
        const top = document.createElement("div");
        top.className = "top";
        const dot = document.createElement("span");
        dot.className = "dot" + (a.rollup.active ? " on" : "");
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = a.label;
        const proj = document.createElement("span");
        proj.className = "proj-tag";
        proj.textContent = a.project;
        top.append(dot, nm, proj);
        const model = document.createElement("div");
        model.className = "model";
        model.textContent = a.rollup.model || "";
        model.title = a.rollup.model || "";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent =
            a.count +
            " events · " +
            b.turnsReached +
            "t\n" +
            fmtCost(a.rollup.costUsd) +
            " · " +
            fmtTok(a.rollup.tokens) +
            " tok";
        agent.append(top, model, meta);
        agent.addEventListener("click", () => selectLane(a.key));
        track.append(agent);

        // turns
        const turns = document.createElement("div");
        turns.className = "race-turns";
        turns.dataset.key = a.key;
        let activeEl = null;
        for (const c of cols) {
            if (turns.childElementCount > 0) {
                const conn = document.createElement("span");
                conn.className = "race-conn";
                turns.append(conn);
            }
            const evs = c === -1 ? b.setup : b.turns.get(c) || [];
            const label = c === -1 ? "SETUP" : "TURN " + c;
            const turn = document.createElement("div");
            const isActive = c === a.activeTurn;
            turn.className = "race-turn " + (isActive ? "active" : "collapsed");

            const head = document.createElement("div");
            head.className = "race-turn-head";
            const lbl = document.createElement("span");
            lbl.className = "race-turn-label";
            lbl.textContent = label;
            const cnt = document.createElement("span");
            cnt.className = "race-turn-count";
            cnt.textContent = evs.length + " events";
            head.append(lbl, cnt);
            turn.append(head);

            if (isActive) {
                activeEl = turn;
                // click the expanded turn's header to collapse (zoom out)
                head.style.cursor = "pointer";
                head.title = "collapse";
                head.addEventListener("click", () => {
                    a.activeTurn = null;
                    a.followLatest = false;
                    renderRace();
                });
                const row = document.createElement("div");
                row.className = "race-events";
                for (const ev of evs) {
                    if (row.childElementCount > 0) {
                        const conn = document.createElement("span");
                        conn.className = "ev-conn";
                        row.append(conn);
                    }
                    row.append(raceEventCard(ev, a));
                }
                turn.append(row);
            } else {
                const snip = turnSnippet(evs);
                if (snip) {
                    const s = document.createElement("div");
                    s.className = "race-turn-snippet";
                    s.textContent = snip;
                    s.title = snip;
                    turn.append(s);
                }
                turn.addEventListener("click", () => {
                    a.activeTurn = c;
                    a.followLatest = false;
                    renderRace();
                });
            }
            turns.append(turn);
        }
        track.append(turns);
        tracks.append(track);

        // follow the latest turn (align it to the start) unless the user pinned
        // one — then restore their horizontal scroll
        if (a.followLatest !== false && activeEl)
            turns.scrollLeft = Math.max(0, activeEl.offsetLeft - turns.offsetLeft - 8);
        else if (raceScroll.has(a.key)) turns.scrollLeft = raceScroll.get(a.key);
    }
}

