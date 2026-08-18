import type { RunStatus } from "./format";
import "./Chip.css";

const LABEL: Record<RunStatus, string> = {
  live: "live",
  pass: "pass",
  fail: "fail",
  open: "open",
};

export function StatusChip({ status, text }: { status: RunStatus; text?: string }) {
  return <span className={`chip ${status}`}>{text ?? LABEL[status]}</span>;
}
