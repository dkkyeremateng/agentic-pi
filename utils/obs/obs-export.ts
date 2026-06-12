// obs-export.ts — offline OTel exporter for the live observability sink.
//
// Reads the ObsEvent sink a workflow appended to and prints an OTLP/JSON trace
// (OpenTelemetry GenAI conventions) to stdout or a file, ready to pipe into any
// OTel-aware backend (Datadog, Phoenix, Langfuse, Honeycomb, …).
//
// Usage:
//   tsx utils/obs/obs-export.ts [--sink <file>] [--run <runId>] [--out <file>]
//
//   --sink   the events.jsonl to read (default: $PI_OBS_SINK or
//            ~/.pi/agent/obs/events.jsonl — the shared collector sink)
//   --run    scope the export to one run (shared runId). Omit for all runs.
//   --out    write to a file instead of stdout.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve as resolvePath } from "path";
import { homedir } from "os";
import { parseEventLine, type ObsEvent } from "./obs-events";
import { eventsToOtlp } from "./obs-otel";

function parseArgs(argv: string[]) {
    const o: { sink?: string; run?: string; out?: string } = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--sink") o.sink = argv[++i];
        else if (a === "--run") o.run = argv[++i];
        else if (a === "--out") o.out = argv[++i];
    }
    return o;
}

function resolveSink(explicit?: string): string {
    const tilde = (p: string) => resolvePath(p.replace(/^~(?=$|\/)/, homedir()));
    if (explicit) return tilde(explicit);
    if (process.env.PI_OBS_SINK) return tilde(process.env.PI_OBS_SINK);
    return join(homedir(), ".pi", "agent", "obs", "events.jsonl");
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const sink = resolveSink(opts.sink);
    if (!existsSync(sink)) {
        console.error(
            `obs-export: no sink at ${sink}\n` +
                "(run a workflow with PI_OBS=1, or pass --sink <file>.)",
        );
        process.exit(1);
    }
    const events: ObsEvent[] = [];
    for (const line of readFileSync(sink, "utf-8").split("\n")) {
        const ev = parseEventLine(line);
        if (ev) events.push(ev);
    }
    if (!events.length) {
        console.error(`obs-export: no events parsed from ${sink}`);
        process.exit(1);
    }
    const otlp = eventsToOtlp(events, {
        runId: opts.run,
        serviceName: "pi-agent-workflow",
    });
    const json = JSON.stringify(otlp, null, 2);
    if (opts.out) {
        writeFileSync(resolvePath(opts.out), json + "\n", "utf-8");
        const n = otlp.resourceSpans[0].scopeSpans[0].spans.length;
        console.error(`obs-export: wrote ${n} span(s) → ${opts.out}`);
    } else {
        process.stdout.write(json + "\n");
    }
}

main();
