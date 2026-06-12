// ── shell — rail collapse + drawer resize (ui.md §4.1) ───────────────────────
// Pure chrome behavior, no view logic. Both preferences persist locally.

// nav rail: collapse to icons-only (52px) and back
(function () {
    const app = $("app");
    if (localStorage.getItem("obs.railCollapsed") === "1")
        app.classList.add("rail-collapsed");
    $("rail-toggle").addEventListener("click", () => {
        const on = app.classList.toggle("rail-collapsed");
        try {
            localStorage.setItem("obs.railCollapsed", on ? "1" : "0");
        } catch {
            /* ignore */
        }
    });
})();

// detail drawer: drag the left-edge grip to resize (clamped, persisted)
(function () {
    const grip = $("drawer-grip");
    const saved = Number(localStorage.getItem("obs.drawerW"));
    if (saved >= 320 && saved <= 760)
        document.documentElement.style.setProperty("--drawer-w", saved + "px");
    grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        grip.classList.add("dragging");
        try {
            grip.setPointerCapture(e.pointerId);
        } catch {
            /* capture is best-effort (synthetic/edge pointers lack ids) */
        }
        let w = 0;
        const move = (ev) => {
            // never let the drawer eat more than half the window
            const max = Math.min(760, Math.floor(window.innerWidth / 2));
            w = Math.min(max, Math.max(320, window.innerWidth - ev.clientX));
            document.documentElement.style.setProperty("--drawer-w", w + "px");
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener(
            "pointerup",
            () => {
                grip.classList.remove("dragging");
                grip.removeEventListener("pointermove", move);
                if (w)
                    try {
                        localStorage.setItem("obs.drawerW", String(w));
                    } catch {
                        /* ignore */
                    }
            },
            { once: true },
        );
    });
})();
