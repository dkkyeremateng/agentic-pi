// Verifies scripts/patch-pi-tui.sh against the INSTALLED pi-tui.
//
// Not a CI test: it needs a real pi install, which a runner does not have. Run it
// by hand after applying or reverting the patch.
//
//   node scripts/verify-pi-tui-patch.mjs
//
// What it demonstrates
// --------------------
// pi-tui positions the cursor with RELATIVE moves (CUU/CUD), which terminals CLAMP
// at the screen edges. If pi's idea of where the cursor is drifts outside the
// visible window, the move it emits cannot land where it thinks -- and because it
// records the move as successful, the drift is inherited by every later frame.
// Rows stop being overwritten and pile up instead. That is the stale-row/duplicate
// "# Todos" behaviour on the dashboard.
//
// The harness drives the real TUI into that state (content taller than the
// terminal, then a drifted hardware cursor) and reports whether the renderer takes
// the unsafe incremental path or falls back to an absolute full repaint.
//
//   UNPATCHED -> incremental render attempted from an off-screen origin (desync
//                persists; the frame is drawn in the wrong place)
//   PATCHED   -> fullRender(true), which repaints absolutely and RECOVERS
//
// The recovery is the real win: the patch does not just avoid creating a desync,
// it makes an existing one self-healing instead of permanent.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

const COLS = 281;
const ROWS = 78;
const CONTENT = 143; // taller than ROWS, so the render is scrolled

const piBin = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const pkgDir = join(dirname(realpathSync(piBin)), "..");
const tuiDir = join(pkgDir, "node_modules/@earendil-works/pi-tui/dist");
const { TUI, Container } = await import(pathToFileURL(join(tuiDir, "tui.js")).href);
const { Text } = await import(pathToFileURL(join(tuiDir, "components/text.js")).href);

const require = createRequire(import.meta.url);
const patched = require("node:fs")
    .readFileSync(join(tuiDir, "tui.js"), "utf8")
    .includes("PATCH (agentic-pi): off-screen cursor-move guard");

const writes = [];
const terminal = {
    columns: COLS,
    rows: ROWS,
    write: (s) => writes.push(s),
    on() {}, off() {}, removeListener() {},
    hideCursor() {}, showCursor() {}, setCursorPosition() {},
};

const tui = new TUI(terminal, false, "/tmp");
const body = new Container();
tui.addChild(body);
const setContent = (arr) => {
    body.clear();
    for (const l of arr) body.addChild(new Text(l, 0, 0));
};
const rows = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}-${i}`);

// Frame 1: establish a scrolled viewport.
setContent(rows(CONTENT, "a"));
tui.doRender();
const viewportTop = tui.previousViewportTop;
console.log(`tui.js is ${patched ? "PATCHED" : "UNPATCHED"}`);
console.log(`frame 1: ${CONTENT} lines on a ${ROWS}-row terminal`);
console.log(`  viewportTop=${viewportTop}  cursorRow=${tui.cursorRow}  fullRedraws=${tui.fullRedraws}`);

// Drift the hardware cursor outside the visible window -- exactly the state a
// clamped relative move leaves behind.
const drifted = viewportTop + ROWS + 60;
tui.hardwareCursorRow = drifted;
const curScreenRow = drifted - viewportTop;
console.log(`\ninjected drift: hardwareCursorRow=${drifted}`);
console.log(`  => pi thinks the cursor is on screen row ${curScreenRow}, but the screen only has rows 0..${ROWS - 1}`);

// Frame 2: change one line in the middle. The renderer must now move the cursor
// relative to an origin that is not on screen.
const before = tui.fullRedraws;
writes.length = 0;
const next = rows(CONTENT, "a");
next[CONTENT - 10] = "CHANGED";
setContent(next);
tui.doRender();

const tookFullRender = tui.fullRedraws > before;
const buf = writes.join("");
const move = /\x1b\[(\d+)([AB])/.exec(buf);
console.log(`\nframe 2: fullRender taken? ${tookFullRender}`);
console.log(`  relative move emitted: ${move ? `\\x1b[${move[1]}${move[2]}` : "(none)"}`);
console.log(`  absolute repaint emitted: ${buf.includes("\x1b[2J") ? "yes (\\x1b[2J)" : "no"}`);

const ok = patched ? tookFullRender : true;
console.log(
    `\n${patched ? "PATCHED" : "UNPATCHED"} expectation: ` +
        (patched
            ? tookFullRender
                ? "PASS - guard caught the off-screen origin and repainted absolutely (desync recovers)"
                : "FAIL - guard did not fire; the patch is not doing its job"
            : tookFullRender
              ? "note: upstream already fell back here"
              : "as expected - upstream renders incrementally from an off-screen origin (desync persists)"),
);
process.exit(ok ? 0 : 1);
