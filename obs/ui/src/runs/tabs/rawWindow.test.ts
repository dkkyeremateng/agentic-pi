import { test } from "node:test";
import assert from "node:assert/strict";
import { ROW_CAP, tailWindow } from "./rawWindow.ts";

test("over the cap, keeps the NEWEST ROW_CAP rows and reports the hidden rest", () => {
  const rows = Array.from({ length: ROW_CAP + 10 }, (_, i) => i);
  const { visible, hidden } = tailWindow(rows, false);
  assert.equal(visible.length, ROW_CAP);
  assert.equal(visible[0], 10); // the oldest 10 were dropped from the front
  assert.equal(visible[visible.length - 1], ROW_CAP + 9); // live edge stays rendered
  assert.equal(hidden, 10);
});

test("at the cap, returns all rows with nothing hidden", () => {
  const rows = Array.from({ length: ROW_CAP }, (_, i) => i);
  const { visible, hidden } = tailWindow(rows, false);
  assert.deepEqual(visible, rows);
  assert.equal(hidden, 0);
});

test("under the cap, returns all rows with nothing hidden", () => {
  const rows = [1, 2, 3];
  const { visible, hidden } = tailWindow(rows, false);
  assert.deepEqual(visible, rows);
  assert.equal(hidden, 0);
});

test("showAll lifts the cap entirely", () => {
  const rows = Array.from({ length: ROW_CAP * 3 }, (_, i) => i);
  const { visible, hidden } = tailWindow(rows, true);
  assert.deepEqual(visible, rows);
  assert.equal(hidden, 0);
});

test("empty input returns empty with nothing hidden", () => {
  assert.deepEqual(tailWindow([], false), { visible: [], hidden: 0 });
  assert.deepEqual(tailWindow([], true), { visible: [], hidden: 0 });
});
