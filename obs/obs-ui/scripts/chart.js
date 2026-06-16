// ── chart — tiny canvas line/area chart + sparkline + table sorter ──────────
// Replaces the hand-rolled SVG timeline. DPR-aware; crosshair + tooltip on
// hover. Small by design — trends and cumulative lines, not a charting lib.

let chartTipEl = null;
function chartTip() {
    if (!chartTipEl) {
        chartTipEl = document.createElement("div");
        chartTipEl.id = "chart-tip";
        chartTipEl.hidden = true;
        document.body.appendChild(chartTipEl);
    }
    return chartTipEl;
}

// Draw a line/area chart into `canvas`. points: [{ x, y }] (x ascending).
// opts: { yFmt(v), xFmt(x), color } — fmts feed the hover tooltip.
function chartLine(canvas, points, opts = {}) {
    const color = opts.color || "#7aa2f7";
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const h = canvas.clientHeight || 120;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (points.length < 2) return;

    const x0 = points[0].x;
    const x1 = points[points.length - 1].x;
    const ymax = Math.max(...points.map((p) => p.y)) || 1;
    const PAD = 4;
    const px = (x) => PAD + ((x - x0) / Math.max(1, x1 - x0)) * (w - 2 * PAD);
    const py = (y) => h - PAD - (y / ymax) * (h - 2 * PAD);

    // gridlines (quarters)
    ctx.strokeStyle = "rgba(44,44,58,0.8)";
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
        ctx.beginPath();
        ctx.moveTo(0, h * f);
        ctx.lineTo(w, h * f);
        ctx.stroke();
    }

    // area fill + line
    ctx.beginPath();
    ctx.moveTo(px(points[0].x), py(points[0].y));
    for (const p of points) ctx.lineTo(px(p.x), py(p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(px(x1), h - PAD);
    ctx.lineTo(px(x0), h - PAD);
    ctx.closePath();
    ctx.fillStyle = "rgba(122,162,247,0.15)";
    ctx.fill();

    // crosshair + tooltip (redraws the chart, then the cursor layer)
    if (canvas._chartCleanup) canvas._chartCleanup();
    const onMove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        // nearest point by x
        let best = points[0];
        let bd = Infinity;
        for (const p of points) {
            const d = Math.abs(px(p.x) - mx);
            if (d < bd) {
                bd = d;
                best = p;
            }
        }
        chartLine(canvas, points, opts); // base redraw
        const c2 = canvas.getContext("2d");
        c2.save();
        c2.scale(1, 1);
        c2.strokeStyle = "rgba(122,162,247,0.6)";
        c2.beginPath();
        c2.moveTo(px(best.x), 0);
        c2.lineTo(px(best.x), h);
        c2.stroke();
        c2.fillStyle = color;
        c2.beginPath();
        c2.arc(px(best.x), py(best.y), 3, 0, Math.PI * 2);
        c2.fill();
        c2.restore();
        const tip = chartTip();
        tip.hidden = false;
        tip.textContent =
            (opts.xFmt ? opts.xFmt(best.x) + " · " : "") +
            (opts.yFmt ? opts.yFmt(best.y) : best.y);
        tip.style.left = e.clientX + 12 + "px";
        tip.style.top = e.clientY - 24 + "px";
    };
    const onLeave = () => {
        chartTip().hidden = true;
        chartLine(canvas, points, opts);
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas._chartCleanup = () => {
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mouseleave", onLeave);
    };
}

// Tiny sparkline (no axes/hover) — e.g. cost across the last N runs.
function chartSpark(canvas, values, color) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 120;
    const h = canvas.clientHeight || 22;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2) return;
    const max = Math.max(...values) || 1;
    const px = (i) => 1 + (i / (values.length - 1)) * (w - 2);
    const py = (v) => h - 2 - (v / max) * (h - 4);
    ctx.beginPath();
    ctx.moveTo(px(0), py(values[0]));
    values.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.strokeStyle = color || "#7aa2f7";
    ctx.lineWidth = 1.25;
    ctx.stroke();
}

// ── sortable tables ──────────────────────────────────────────────────────────
// Make a rendered table.lead sortable by clicking its headers. Numeric-aware
// ($1.2, 3.4s, 12k, 800ms, plain numbers); toggles asc/desc with aria-sort.
function makeSortable(table) {
    const ths = table.querySelectorAll("thead th");
    ths.forEach((th, col) => {
        th.classList.add("sortable");
        th.addEventListener("click", () => {
            const tbody = table.querySelector("tbody");
            if (!tbody) return;
            const dir = th.getAttribute("aria-sort") === "descending" ? 1 : -1;
            ths.forEach((o) => o.removeAttribute("aria-sort"));
            th.setAttribute(
                "aria-sort",
                dir === 1 ? "ascending" : "descending",
            );
            const num = (s) => {
                s = String(s).trim();
                let m = s.match(/^(\d+)m(?:(\d+)s)?$/); // "3m40s" / "5m"
                if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
                m = s.replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/);
                if (!m) return null;
                let v = parseFloat(m[0]);
                if (/\dk\b/i.test(s.replace(/\./g, ""))) v *= 1000; // "7.2k"
                if (/ms\b/.test(s)) v /= 1000;
                return v;
            };
            const rows = [...tbody.children];
            rows.sort((a, b) => {
                const av = a.children[col]?.textContent.trim() ?? "";
                const bv = b.children[col]?.textContent.trim() ?? "";
                const an = num(av);
                const bn = num(bv);
                if (an != null && bn != null) return (an - bn) * dir;
                return av.localeCompare(bv) * dir;
            });
            rows.forEach((r) => tbody.appendChild(r));
        });
    });
}
