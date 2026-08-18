// Styled replacement for the native prompt() the obs token auth used to pop.
// Listens for the TOKEN_REQUIRED_EVENT that auth.ts fires on a 401, then renders
// an on-brand modal: paste the PI_OBS_TOKEN, store it, reload so every request
// retries with it. Esc cancels, Enter in the field submits, focus lands on the
// field and Tab cycles within the dialog.
import { useEffect, useRef, useState } from "react";
import { TOKEN_REQUIRED_EVENT, resolveTokenPrompt } from "../data/auth";
import "./TokenGate.css";

export function TokenGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const unlockRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onReq = () => setOpen(true);
    window.addEventListener(TOKEN_REQUIRED_EVENT, onReq);
    return () => window.removeEventListener(TOKEN_REQUIRED_EVENT, onReq);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const submit = () => {
    if (!value.trim()) return;
    resolveTokenPrompt(value); // stores + reloads
  };
  const cancel = () => {
    setOpen(false);
    resolveTokenPrompt(null); // re-arm so a later 401 can prompt again
  };

  return (
    <div
      className="tg-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="tg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tg-title"
        aria-describedby="tg-sub"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            cancel();
            return;
          }
          if (e.key !== "Tab") return;
          // minimal focus trap: cycle input → Cancel → Unlock
          e.preventDefault();
          const order = [inputRef.current, cancelRef.current, unlockRef.current].filter(
            (el): el is HTMLInputElement | HTMLButtonElement => el != null && !el.disabled,
          );
          if (order.length === 0) return;
          const i = order.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
          const next = e.shiftKey
            ? order[(i <= 0 ? order.length : i) - 1]
            : order[(i + 1) % order.length];
          next.focus();
        }}
      >
        <div className="tg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2.5" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            <circle cx="12" cy="16.5" r="1.4" fill="currentColor" stroke="none" />
          </svg>
        </div>

        <h2 id="tg-title" className="tg-title">Authentication required</h2>
        <p id="tg-sub" className="tg-sub">
          This observability server is protected. Paste the{" "}
          <code>PI_OBS_TOKEN</code> it was started with.
        </p>

        <input
          ref={inputRef}
          className="tg-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="PI_OBS_TOKEN"
          aria-label="PI_OBS_TOKEN"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <div className="tg-actions">
          <button ref={cancelRef} className="tg-btn tg-ghost" type="button" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={unlockRef}
            className="tg-btn tg-primary"
            type="button"
            onClick={submit}
            disabled={!value.trim()}
          >
            Unlock
          </button>
        </div>

        <p className="tg-hint">
          Stored in this browser only. An invalid token re-opens this dialog.
        </p>
      </div>
    </div>
  );
}
