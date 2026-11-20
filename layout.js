// The two viewports' rects, device pixels from the canvas's top left: each window spans its
// strip's columns (the 3D strip over viewport 0, the 2D strip over viewport 1) and the canvas's
// height. A strip a maximise hides (no width) gives an empty rect, which hides that viewport and
// keeps its camera (setViewportRects). Pure: CSS boxes in, device rects out.
export function viewportRects(canvas, strips, dpr) {
    return strips.map((s) => {
        const left = Math.max(0, s.left - canvas.left), right = Math.min(canvas.width, s.left + s.width - canvas.left);
        if (!(right - left > 0) || !(canvas.height > 0)) return [0, 0, 0, 0];
        const x0 = Math.round(left * dpr), x1 = Math.round(right * dpr);
        return [x0, 0, x1 - x0, Math.round(canvas.height * dpr)];
    });
}

/** Which viewport a canvas pixel (device pixels) is in: 0, 1, or -1 for neither. */
export function viewportAt(rects, [x, y]) {
    return rects.findIndex(([rx, ry, rw, rh]) => rw > 0 && rh > 0 && x >= rx && x < rx + rw && y >= ry && y < ry + rh);
}
