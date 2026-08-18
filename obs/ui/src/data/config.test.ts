import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBase, resolveApiBase, apiUrl, API_BASE } from "./config";

test("normalizeBase trims whitespace and trailing slashes", () => {
  assert.equal(normalizeBase("  https://a.ts.net/api/  "), "https://a.ts.net/api");
  assert.equal(normalizeBase("/api/"), "/api");
  assert.equal(normalizeBase("/api"), "/api");
  assert.equal(normalizeBase("https://a.ts.net///"), "https://a.ts.net");
  assert.equal(normalizeBase(""), "");
  assert.equal(normalizeBase(undefined), "");
  assert.equal(normalizeBase(null), "");
});

test("resolveApiBase honours precedence: param > stored > build > default", () => {
  assert.equal(
    resolveApiBase({ param: "https://p.ts.net/api", stored: "https://s/api", build: "/b" }),
    "https://p.ts.net/api",
  );
  assert.equal(resolveApiBase({ param: "", stored: "https://s.ts.net/api", build: "/b" }), "https://s.ts.net/api");
  assert.equal(resolveApiBase({ param: null, stored: null, build: "/obs-api/" }), "/obs-api");
  assert.equal(resolveApiBase({}), "/api"); // default when everything is empty
  assert.equal(resolveApiBase({ param: "   ", stored: "  ", build: "" }), "/api"); // blanks fall through
});

test("in a non-browser/test env, API_BASE falls back to the default and apiUrl joins", () => {
  // No window/localStorage/import.meta.env.VITE_API_BASE under `tsx --test`.
  assert.equal(API_BASE, "/api");
  assert.equal(apiUrl("/runs"), "/api/runs");
  assert.equal(apiUrl("/stream?run=x"), "/api/stream?run=x");
});
