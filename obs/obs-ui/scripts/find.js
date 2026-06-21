// ── search view (cross-run, whole-sink) ──────────────────────────────────────
// Server-side substring search over every run ever recorded (/search scans the
// sink file), so "which run touched obs-server.ts?" is answerable. Rows open
// the event inspector; the run cell jumps to the Trace view pinned to that run.
// View key is "find" — the id "search" belongs to the Single view's filter box.
let findBusy = false;
let findLast = ""; // last executed query (re-run guard)
let findFilters = {}; // parsed run:/agent:/type:/project: prefixes

// `run:abc agent:scout type:tool_end project:foo` narrow client-side; the
// remaining words go to the server's raw-line scan. With ONLY prefixes, the
// first filter value doubles as the server query (it appears in raw lines).
function parseFindQuery(raw) {
    const filters = {};
    const rest = [];
    for (const tok of raw.split(/\s+/)) {
        const m = tok.match(/^(run|agent|type|project):(.+)$/i);
        if (m) filters[m[1].toLowerCase()] = m[2].toLowerCase();
        else if (tok) rest.push(tok);
    }
    return {
        filters,
        q: rest.join(" ") || Object.values(filters)[0] || "",
    };
}

function passesFindFilters(ev) {
    const f = findFilters;
    if (f.run && !(ev.runId || "").toLowerCase().startsWith(f.run))
        return false;
    if (f.agent && ev.agent.toLowerCase() !== f.agent) return false;
    if (f.type && ev.type !== f.type) return false;
    if (f.project && projectName(ev.cwd).toLowerCase() !== f.project)
        return false;
    return true;
}

// recent queries (last 8, deduped) feed the input's <datalist>
function findRecents() {
    try {
        return JSON.parse(localStorage.getItem("obs.findRecent") || "[]");
    } catch {
        return [];
    }
}
function rememberFind(raw) {
    const list = [raw, ...findRecents().filter((x) => x !== raw)].slice(0, 8);
    try {
        localStorage.setItem("obs.findRecent", JSON.stringify(list));
    } catch {
        /* ignore */
    }
    renderFindRecents();
}
function renderFindRecents() {
    const dl = $("find-recent");
    dl.innerHTML = "";
    for (const q of findRecents()) {
        const o = document.createElement("option");
        o.value = q;
        dl.appendChild(o);
    }
}
renderFindRecents();

function runFind() {
    const raw = $("find-q").value.trim();
    if (!raw || findBusy) return;
    const { filters, q } = parseFindQuery(raw);
    if (!q) return;
    findBusy = true;
    findLast = raw;
    findFilters = filters;
    $("find-axis").textContent = "searching…";
    $("find-results").innerHTML =
        '<div class="skeleton find-skel"></div>'.repeat(4);
    ObsAuth.fetch("/search?q=" + encodeURIComponent(q) + "&limit=200")
        .then((r) => r.json())
        .then((evs) => {
            rememberFind(raw);
            renderFindResults(
                q,
                (Array.isArray(evs) ? evs : [])
                    .map(normalizeEvent)
                    .filter(passesFindFilters),
            );
        })
        .catch(() => {
            $("find-axis").textContent = "search failed (server too old?)";
        })
        .finally(() => {
            findBusy = false;
        });
}

// ±60 chars of payload context around the first match, with the hit bolded.
function findSnippet(ev, q) {
    let hay = "";
    try {
        hay = JSON.stringify(ev.payload || {});
    } catch {
        hay = "";
    }
    let i = hay.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) {
        // matched the envelope (agent/runId/…) — show the payload head instead
        return { pre: hay.slice(0, 100), hit: "", post: hay.length > 100 ? "…" : "" };
    }
    const a = Math.max(0, i - 60);
    const b = Math.min(hay.length, i + q.length + 60);
    return {
        pre: (a > 0 ? "…" : "") + hay.slice(a, i),
        hit: hay.slice(i, i + q.length),
        post: hay.slice(i + q.length, b) + (b < hay.length ? "…" : ""),
    };
}

function renderFindResults(q, evs) {
    evs.sort((x, y) => y.ts - x.ts); // newest first
    $("find-empty").style.display = evs.length ? "none" : "block";
    if (!evs.length)
        $("find-empty").textContent = `No events match "${q}" anywhere in the sink.`;
    $("find-axis").innerHTML =
        "<b>" +
        evs.length +
        "</b> match(es) for <b>" +
        escHtml(q) +
        "</b>" +
        (evs.length >= 200 ? " · showing the newest 200" : "");

    const box = $("find-results");
    box.innerHTML = "";
    const table = document.createElement("table");
    table.className = "lead";
    table.innerHTML =
        "<thead><tr><th>when</th><th>project</th><th>run</th><th>agent</th>" +
        "<th>type</th><th>match</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const ev of evs) {
        const tr = document.createElement("tr");
        tr.className = "find-row";
        const snip = findSnippet(ev, q);
        const runCell = ev.runId
            ? '<a class="find-run" title="open in Trace">' +
              escHtml(ev.runId.slice(0, 18)) +
              "</a>"
            : "—";
        tr.innerHTML =
            "<td>" +
            fmtWhen(ev.ts) +
            "</td><td>" +
            escHtml(projectName(ev.cwd)) +
            "</td><td>" +
            runCell +
            '</td><td class="tool">' +
            escHtml(ev.agent) +
            "</td><td>" +
            escHtml(ev.type) +
            '</td><td class="find-snip">' +
            escHtml(snip.pre) +
            "<b>" +
            escHtml(snip.hit) +
            "</b>" +
            escHtml(snip.post) +
            "</td>";
        // Row → inspector with the full event; run cell → Trace pinned to it.
        tr.addEventListener("click", () => openInspector(ev, null));
        const runLink = tr.querySelector(".find-run");
        if (runLink)
            runLink.addEventListener("click", (e) => {
                e.stopPropagation();
                traceRun = ev.runId;
                setView("trace");
            });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    makeSortable(table);
}
