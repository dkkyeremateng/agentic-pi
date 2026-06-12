// ── combobox — a filterable dropdown over dynamic items ──────────────────────
// Replaces native <select> run pickers (they break past ~30 runs). The input
// shows the current selection's label when closed; focusing it opens the list
// and typing filters. Items: { value, label, sub?, live? }. Used by Trace now;
// Stats/Compare adopt it in P4.
function makeCombo({ input, list, onPick }) {
    let items = [];
    let display = ""; // label shown while closed
    let current = null; // value of the current selection (for the ✓ marker)
    let shown = [];
    let sel = 0;
    let open = false;

    function render() {
        const q = input.value.trim().toLowerCase();
        shown = q
            ? items.filter((i) =>
                  (i.label + " " + (i.sub || "") + " " + (i.value || ""))
                      .toLowerCase()
                      .includes(q),
              )
            : items;
        sel = Math.min(sel, Math.max(0, shown.length - 1));
        list.innerHTML = "";
        if (!shown.length) {
            list.innerHTML = '<div class="combo-empty">no matches</div>';
            return;
        }
        shown.forEach((item, i) => {
            // The current selection (by value, or by label when no value given).
            const isCur =
                current != null ? item.value === current : item.label === display;
            const el = document.createElement("div");
            el.className =
                "combo-item" +
                (i === sel ? " sel" : "") +
                (item.live ? " live" : "") +
                (isCur ? " cur" : "");
            const check = document.createElement("span");
            check.className = "combo-check";
            check.textContent = isCur ? "✓" : "";
            el.appendChild(check);
            const lbl = document.createElement("span");
            lbl.className = "combo-label";
            lbl.textContent = item.label;
            el.appendChild(lbl);
            if (item.sub) {
                const s = document.createElement("span");
                s.className = "combo-sub";
                s.textContent = item.sub;
                el.appendChild(s);
            }
            // mousedown (not click) so the pick wins over the input's blur
            el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                pick(i);
                input.blur();
            });
            el.addEventListener("mousemove", () => {
                if (sel !== i) {
                    sel = i;
                    render();
                }
            });
            list.appendChild(el);
        });
        const selEl = list.children[sel];
        if (selEl && selEl.scrollIntoView)
            selEl.scrollIntoView({ block: "nearest" });
    }

    function pick(i) {
        const it = shown[i];
        close();
        if (it) onPick(it.value);
    }
    function openList() {
        // Nothing to choose (0–1 items) — stay a static label, like a 1-option
        // <select>; don't pop a dropdown on focus.
        if (open || items.length <= 1) return;
        open = true;
        input.value = "";
        list.hidden = false;
        sel = 0;
        render();
    }
    function close() {
        open = false;
        list.hidden = true;
        input.value = display;
    }

    input.addEventListener("focus", openList);
    input.addEventListener("input", () => {
        if (!open) openList();
        sel = 0;
        render();
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            sel = Math.min(sel + 1, shown.length - 1);
            render();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            sel = Math.max(sel - 1, 0);
            render();
        } else if (e.key === "Enter") {
            pick(sel);
            input.blur();
        } else if (e.key === "Escape") {
            close();
            input.blur();
        }
    });

    return {
        // Refresh the option set + the closed-state label. While the list is
        // open we re-render in place (live runs keep streaming in).
        update(newItems, newDisplay, newValue) {
            items = newItems;
            display = newDisplay;
            current = newValue ?? null; // which option shows the ✓
            // With 0–1 options there's nothing to filter; make the input a static,
            // read-only label (no caret, no dropdown) — matching a 1-option select.
            input.readOnly = newItems.length <= 1;
            if (open) render();
            else input.value = display;
        },
    };
}
