// ── describe an event into renderable parts ──────────────────────────────────
function describe(ev) {
    const p = ev.payload || {};
    let kls = "sys";
    let badge = ev.type;
    let detail = "";
    switch (ev.type) {
        case "session_start":
            badge = "start";
            detail = p.model ? "model " + p.model : "";
            break;
        case "boot": {
            badge = "boot";
            const parts = [];
            if (p.tools) parts.push(p.tools.length + " tools");
            if (p.skills) parts.push(p.skills.length + " skills");
            if (p.contextFiles) parts.push(p.contextFiles.length + " ctx");
            if (p.promptChars) parts.push(fmtTok(p.promptChars) + "ch prompt");
            detail = parts.join(" · ");
            break;
        }
        case "session_end":
            badge = "end";
            detail = p.reason || "";
            break;
        case "turn_start":
            kls = "turn";
            badge = "turn " + (p.turnIndex ?? "");
            detail = "thinking…";
            break;
        case "turn_end": {
            kls = "turn";
            badge = "turn " + (p.turnIndex ?? "");
            const tok = p.tokens && p.tokens.total ? fmtTok(p.tokens.total) : "";
            const ctx =
                p.context && p.context.percent != null
                    ? " · ctx " + Math.round(p.context.percent) + "%"
                    : "";
            detail =
                (p.stopReason || "done") +
                (tok ? " · " + tok + " tok" : "") +
                (p.costUsd ? " · " + fmtCost(p.costUsd) : "") +
                (p.durationMs ? " · " + fmtMs(p.durationMs) : "") +
                (p.prefillMs ? " · prefill " + fmtMs(p.prefillMs) : "") +
                (p.tps ? " · " + p.tps + " tok/s" : "") +
                ctx;
            break;
        }
        case "message":
            if (p.kind === "thinking") {
                kls = "think";
                badge = "think";
            } else if (p.kind === "user") {
                kls = "user";
                badge = "user";
            } else {
                kls = "say";
                badge = "say";
            }
            detail = p.text || "";
            break;
        case "tool_start":
            kls = "tool";
            badge = p.toolName || "tool";
            detail = p.arg || "";
            break;
        case "tool_end":
            kls = p.isError ? "err" : "result";
            badge = p.toolName || "tool";
            detail =
                (p.isError ? "ERROR " : "") +
                (p.result || "ok") +
                (p.durationMs ? "  (" + fmtMs(p.durationMs) + ")" : "");
            break;
        case "model_change":
            badge = "model";
            detail = p.model || "";
            break;
        case "dispatch_start":
            kls = "dispatch";
            badge = "dispatch→" + (p.agent || "?");
            detail =
                "attempt " + (p.attempt || 1) + (p.task ? " · " + p.task : "");
            break;
        case "dispatch_retry":
            kls = "dispatch";
            badge = "retry " + (p.agent || "?");
            detail =
                "attempt " +
                (p.attempt || 2) +
                (p.reason ? " · " + p.reason : "");
            break;
        case "dispatch_end":
            kls = p.status === "error" ? "err" : "dispatch";
            badge = "dispatch " + (p.status || "done");
            detail =
                (p.agent || "?") +
                (p.reason ? " · " + p.reason : "") +
                (p.attempts && p.attempts > 1 ? " · " + p.attempts + " tries" : "") +
                (p.durationMs ? " · " + fmtMs(p.durationMs) : "");
            break;
        case "compaction":
            badge = "compact";
            detail = "context compacted";
            break;
        case "error":
            kls = "err";
            badge = "error";
            detail =
                (p.source ? p.source + " " : "") + (p.message || p.status || "");
            break;
        default:
            detail = JSON.stringify(p);
    }
    return { kls, badge, detail };
}

// The full, expand-on-click detail for an event.
function fullDetail(ev) {
    const p = ev.payload || {};
    switch (ev.type) {
        case "tool_start":
            return (
                (p.argsText || p.arg || "(no args)") +
                (p.argsTruncated ? "\n\n… (args truncated)" : "")
            );
        case "tool_end":
            return (
                (p.resultText || p.result || "(no result)") +
                (p.resultTruncated ? "\n\n… (result truncated)" : "")
            );
        case "message":
            return p.text || "";
        case "boot":
            return JSON.stringify(
                {
                    tools: p.tools,
                    skills: p.skills,
                    contextFiles: p.contextFiles,
                    promptChars: p.promptChars,
                    promptHash: p.promptHash,
                },
                null,
                2,
            );
        default:
            return JSON.stringify(p, null, 2);
    }
}

function toggleExpand(row, ev) {
    const next = row.nextSibling;
    if (next && next.classList && next.classList.contains("xpanel")) {
        next.remove();
        return;
    }
    const panel = document.createElement("div");
    panel.className = "xpanel";
    const pre = document.createElement("pre");
    pre.textContent = fullDetail(ev);
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.textContent = "copy";
    copy.addEventListener("click", (e) => {
        e.stopPropagation();
        if (navigator.clipboard) navigator.clipboard.writeText(pre.textContent);
        copy.textContent = "copied";
        setTimeout(() => (copy.textContent = "copy"), 1000);
    });
    panel.append(copy, pre);
    row.parentNode.insertBefore(panel, row.nextSibling);
}

// `full` (Single view) rows are expandable; swimlane lane rows are static.
function makeRow(ev, full) {
    const { kls, badge, detail } = describe(ev);
    const oneLine = detail.split("\n")[0];
    const row = document.createElement("div");
    row.className = "row" + (full ? " expandable" : " new");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(ev.ts);
    const em = document.createElement("span");
    em.className = "row-emoji";
    em.textContent = emojiFor(ev);
    const b = document.createElement("span");
    b.className = "badge " + kls;
    b.textContent = badge;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = oneLine;
    if (detail) d.title = detail;

    if (full) {
        const caret = document.createElement("span");
        caret.className = "caret";
        caret.textContent = "›";
        row.append(caret, t, em, b, d);
        row.addEventListener("click", () => {
            const sel = window.getSelection && String(window.getSelection());
            if (sel) return;
            caret.textContent = caret.textContent === "›" ? "⌄" : "›";
            toggleExpand(row, ev);
        });
    } else {
        row.append(t, em, b, d);
        setTimeout(() => row.classList.remove("new"), 600);
    }
    return row;
}

