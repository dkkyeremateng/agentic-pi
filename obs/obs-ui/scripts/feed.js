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

// ── event icons (sprite ids + status color class) ────────────────────────────
// Replaces the emoji set: consistent stroke icons that follow the theme.
function iconFor(ev) {
    const p = ev.payload || {};
    switch (ev.type) {
        case "session_start":
            return { id: "power", cls: "warn" };
        case "boot":
            return { id: "cpu", cls: "dim" };
        case "session_end":
            return { id: "flag", cls: "dim" };
        case "turn_start":
            return { id: "play", cls: "accent" };
        case "turn_end":
            return { id: "square", cls: "accent" };
        case "tool_start":
            return { id: "wrench", cls: "tool" };
        case "tool_end":
            return p.isError
                ? { id: "xcircle", cls: "err" }
                : { id: "check", cls: "ok" };
        case "model_change":
            return { id: "refresh", cls: "magenta" };
        case "dispatch_start":
            return { id: "send", cls: "magenta" };
        case "dispatch_retry":
            return { id: "refresh", cls: "warn" };
        case "dispatch_end":
            return p.status === "error"
                ? { id: "xcircle", cls: "err" }
                : { id: "recv", cls: "magenta" };
        case "compaction":
            return { id: "shrink", cls: "dim" };
        case "error":
            return { id: "xcircle", cls: "err" };
        case "message":
            return p.kind === "user"
                ? { id: "user", cls: "dim" }
                : p.kind === "thinking"
                  ? { id: "chat", cls: "dim" }
                  : { id: "chat", cls: "fg" };
        default:
            return { id: "dotc", cls: "dim" };
    }
}

function iconEl(ev) {
    const { id, cls } = iconFor(ev);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon ev-icon " + cls);
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-" + id);
    svg.appendChild(use);
    return svg;
}

// Swimlane mini-feed rows (static, one line). The Single view renders its own
// virtualized rows (single.js makeVRow); full detail lives in the drawer.
function makeRow(ev) {
    const { kls, badge, detail } = describe(ev);
    const row = document.createElement("div");
    row.className = "row new";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(ev.ts);
    const em = iconEl(ev);
    const b = document.createElement("span");
    b.className = "badge " + kls;
    b.textContent = badge;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = detail.split("\n")[0];
    if (detail) d.title = detail;
    row.append(t, em, b, d);
    setTimeout(() => row.classList.remove("new"), 600);
    return row;
}

