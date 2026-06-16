// ── vlist — a windowed (virtualized) list over fixed-height rows ─────────────
// The Single feed can hold tens of thousands of events; rendering only the
// visible window (±buffer) keeps the DOM tiny and scrolling smooth. Rows are
// absolutely positioned at i*rowH inside a container sized to the full list.
function makeVList({ container, scroller, rowH }) {
    let items = [];
    let renderItem = null; // (item) => HTMLElement (gets .vrow-pos applied)
    let lo = -1;
    let hi = -1;
    const BUF = 30;

    function place(el, i) {
        el.style.position = "absolute";
        el.style.left = "0";
        el.style.right = "0";
        el.style.top = i * rowH + "px";
        el.style.height = rowH + "px";
    }

    function redraw(force) {
        container.style.height = items.length * rowH + "px";
        // The container's offset within the scroller's scroll space — computed
        // from rects (offsetTop would be relative to any positioned ancestor).
        const contTop =
            container.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop;
        const top = scroller.scrollTop - contTop;
        const h = scroller.clientHeight;
        const i0 = Math.max(0, Math.floor(top / rowH) - BUF);
        const i1 = Math.min(items.length, Math.ceil((top + h) / rowH) + BUF);
        if (!force && i0 === lo && i1 === hi) return;
        lo = i0;
        hi = i1;
        container.innerHTML = "";
        if (!renderItem) return;
        const frag = document.createDocumentFragment();
        for (let i = i0; i < i1; i++) {
            const el = renderItem(items[i]);
            place(el, i);
            frag.appendChild(el);
        }
        container.appendChild(frag);
    }

    scroller.addEventListener("scroll", () => redraw(false), {
        passive: true,
    });

    return {
        // Replace the whole item set (filter change, agent switch).
        setItems(arr, renderFn) {
            items = arr;
            renderItem = renderFn;
            redraw(true);
        },
        // Append one item (live tail) — cheap height bump + redraw.
        append(item) {
            items.push(item);
            redraw(true);
        },
        redraw: () => redraw(true),
        count: () => items.length,
    };
}
