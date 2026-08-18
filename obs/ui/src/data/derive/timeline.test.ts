import { test } from "node:test";
import assert from "node:assert/strict";
import { fullView, viewBar, revealBar, clampView, fracToTs, tsToFrac, isZoomed, MIN_SPAN_MS } from "./timeline.ts";

const bounds = fullView(0, 1000);

test("viewBar projects and clips to the window", () => {
  // full window: a bar 0..500 → left 0, width .5
  let b = viewBar(0, 500, bounds);
  assert.equal(b.left, 0);
  assert.equal(b.width, 0.5);
  assert.equal(b.visible, true);

  // zoomed window 250..750: bar 0..500 clips to left 0, right (500-250)/500=.5
  b = viewBar(0, 500, { start: 250, end: 750 });
  assert.equal(b.left, 0);
  assert.equal(b.width, 0.5);

  // bar entirely left of the window → not visible
  b = viewBar(0, 100, { start: 250, end: 750 });
  assert.equal(b.visible, false);
  assert.equal(b.width, 0);
});

test("revealBar grows from start to playhead, capped at the bar end", () => {
  // playhead before the bar → nothing revealed
  assert.equal(revealBar(400, 800, bounds, 200).width, 0);
  // playhead mid-bar → half revealed (400..600 of a 0..1000 window = .2)
  let r = revealBar(400, 800, bounds, 600);
  assert.equal(r.left, 0.4);
  assert.ok(Math.abs(r.width - 0.2) < 1e-9);
  // playhead past the bar → fully revealed
  r = revealBar(400, 800, bounds, 1000);
  assert.ok(Math.abs(r.width - 0.4) < 1e-9);
});

test("clampView respects bounds and the minimum span", () => {
  // too-tight selection widens to MIN_SPAN
  let v = clampView({ start: 500, end: 500 + 10 }, bounds);
  assert.equal(v.end - v.start, MIN_SPAN_MS);
  // window pushed past the end slides back inside
  v = clampView({ start: 900, end: 1400 }, bounds);
  assert.equal(v.end, 1000);
  assert.ok(v.start >= 0);
});

test("frac/ts round-trip and isZoomed", () => {
  const win = { start: 200, end: 700 };
  assert.equal(fracToTs(0.5, win), 450);
  assert.equal(tsToFrac(450, win), 0.5);
  assert.equal(isZoomed(bounds, bounds), false);
  assert.equal(isZoomed({ start: 100, end: 400 }, bounds), true);
});
