// Report what the edit hook actually did, from its own audit log.
//   npm run edit:coverage            -- everything in the log
//   npm run edit:coverage -- 2026-08-30   -- only records at/after that prefix
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseAuditLog, formatCoverage } from "../utils/edit/edit-coverage";

const log = join(homedir(), ".pi", "agent", "edit-repair.log");
let text = "";
try {
    text = readFileSync(log, "utf8");
} catch {
    console.error(`edit-coverage: no audit log at ${log}`);
    process.exit(1);
}
console.log(formatCoverage(parseAuditLog(text, process.argv[2] || "")));
