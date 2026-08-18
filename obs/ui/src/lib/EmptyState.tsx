// A centered empty-state block — icon, heading, one-line hint, optional CTA.
// Replaces bare "Nothing here" lines floating in a large void (skill:
// empty-states — guide the user with a message AND an action). Shared so the
// pattern reads the same everywhere it's used.
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./EmptyState.css";

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName;
  title: string;
  hint?: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="emptystate">
      <div className="es-icon">
        <Icon name={icon} size={26} />
      </div>
      <div className="es-title">{title}</div>
      {hint && <div className="es-hint">{hint}</div>}
      {action && (
        <button className="es-cta" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
