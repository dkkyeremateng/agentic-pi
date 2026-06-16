// ── formatting ───────────────────────────────────────────────────────────────
function fmtTok(n) {
    n = Math.round(n || 0);
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
}
function fmtCost(n) {
    n = n || 0;
    return "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}
function fmtDur(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m + "m" + String(s % 60).padStart(2, "0") + "s";
}
function fmtMs(ms) {
    if (!ms) return "";
    return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}
function clock(ts) {
    return new Date(ts).toTimeString().slice(0, 8);
}
// Run-picker timestamp: time-of-day for today, date-qualified for older runs
// (archived runs can be days old, where "14:02:11" alone is ambiguous).
function fmtWhen(ts) {
    const d = new Date(ts);
    const hms = d.toTimeString().slice(0, 8);
    if (d.toDateString() === new Date().toDateString()) return hms;
    return d.getMonth() + 1 + "/" + d.getDate() + " " + hms.slice(0, 5);
}

