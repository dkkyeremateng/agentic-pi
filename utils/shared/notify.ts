// ABOUTME: Desktop-notification helper. Emits an OSC 9 escape (supported by
// iTerm2, kitty, WezTerm, Ghostty, and others) so long-running workflows can ping
// the user when they finish or need input. Disabled with PI_NOTIFY=0. Kept pure
// (string builder + injectable writer) so it is unit-testable.

// Build the OSC 9 desktop-notification escape for `message`. Control chars are
// stripped (they would corrupt the sequence / terminal) and the text is capped.
// Returns "" for an empty/blank message.
export function notifyEscape(message: string): string {
    const clean = (message || "")
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim()
        .slice(0, 200);
    if (!clean) return "";
    return `\x1b]9;${clean}\x07`; // OSC 9 ; <text> BEL
}

// Notifications are on unless PI_NOTIFY=0.
export function notificationsEnabled(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env.PI_NOTIFY !== "0";
}

// Emit a desktop notification to the terminal. No-op when disabled, when the
// message is empty, or when stdout is not a TTY. Writer + TTY flag are injectable
// for testing. Returns whether anything was written.
export function emitNotification(
    message: string,
    opts: {
        write?: (s: string) => void;
        isTTY?: boolean;
        env?: NodeJS.ProcessEnv;
    } = {},
): boolean {
    const env = opts.env ?? process.env;
    if (!notificationsEnabled(env)) return false;
    const seq = notifyEscape(message);
    if (!seq) return false;
    const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
    if (!isTTY) return false;
    (opts.write ?? ((s: string) => process.stdout.write(s)))(seq);
    return true;
}
