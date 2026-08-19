// Indentation gate for the dashboard sources.
//
// It exists because of a specific, repeatable failure: a coding agent asked to
// insert a block into obs/ui/src/runs/tabs/RawTab.tsx produced it at ONE space
// of indentation where the file uses two, and the change shipped. Nothing
// caught it — TypeScript does not care about leading whitespace, so typecheck,
// the tests and the build were all green on a file that no longer matched
// itself.
//
// .editorconfig already states the rule (`[obs/ui/**] indent_size = 2`). This
// makes it checkable, which is the only part that was missing.
//
// It is DELIBERATELY NARROW. It asserts that indentation is spaces and that the
// count is even; it does not check nesting depth, line width, quotes, or
// anything else a real formatter would. A repository-wide formatter is a bigger
// decision — it reformats every existing file — and this is not a substitute
// for one. It is the smallest check that catches the failure that happened.
//
// Continuation lines are the reason for the odd/even rule rather than a
// strict-multiple-of-2 rule on nesting: code that aligns to an open paren or a
// JSX attribute is still even, so it passes without needing an exception.
//
// There is deliberately NO attempt to track template literals. Counting
// backticks per line cannot tell a template apart from a backtick inside a
// regex, a string or a comment, and guessing wrong is not a harmless miss: one
// unbalanced line flips the state and every later line in that file goes
// unchecked. chat/markdown.ts is the worked example — its code-span regexes
// (/`([^`]+)`/g) and fence handling left 130 of its lines silently skipped, in
// the one file that most needs checking. Checking every line instead costs
// nothing: the tree has zero odd-indented lines inside templates today.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["obs/ui/src"];
const EXTS = new Set([".ts", ".tsx"]);
const SKIP = new Set(["node_modules", "dist", "build", ".git"]);

/** Every .ts/.tsx file under the roots, depth-first. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (EXTS.has(extname(name))) out.push(p);
  }
  return out;
}

const problems = [];
for (const root of ROOTS) {
  for (const file of sources(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trim() === "") return;
      // A block comment's continuation lines align their asterisks under the
      // opening slash-star, which puts them one space in. That is the house
      // style throughout obs/ui and has nothing to do with code indentation.
      if (line.trim().startsWith("*")) return;

      const indent = line.match(/^[ \t]*/)[0];
      if (indent.includes("\t")) {
        problems.push(`${file}:${i + 1}: tab in indentation (obs/ui uses spaces)`);
        return;
      }
      if (indent.length % 2 !== 0) {
        problems.push(
          `${file}:${i + 1}: ${indent.length}-space indent (obs/ui uses multiples of 2)`,
        );
      }
    });
  }
}

if (problems.length > 0) {
  console.error("indentation does not match .editorconfig (obs/ui: indent_size = 2):\n");
  for (const p of problems) console.error("  " + p);
  console.error(`\n${problems.length} line(s). Fix the indentation and re-run.`);
  process.exit(1);
}
console.log("indentation ok");
