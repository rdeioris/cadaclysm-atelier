import assert from "node:assert/strict";
import { viewportRects, viewportAt } from "../layout.js";

const canvas = { left: 10, width: 1006, height: 500 };
// 3D strip over the first 500 CSS px, the divider 6, the 2D strip the remaining 500
const r = viewportRects(canvas, [{ left: 10, width: 500 }, { left: 516, width: 500 }], 2);
assert.deepEqual(r, [[0, 0, 1000, 1000], [1012, 0, 1000, 1000]]);
assert.equal(viewportAt(r, [10, 10]), 0);
assert.equal(viewportAt(r, [1005, 10]), -1, "under the divider: neither");
assert.equal(viewportAt(r, [1500, 999]), 1);
// F3: the 2D strip has no width: its viewport is an empty rect
const max3d = viewportRects(canvas, [{ left: 10, width: 1006 }, { left: 1016, width: 0 }], 1);
assert.deepEqual(max3d[1], [0, 0, 0, 0]);
assert.equal(viewportAt(max3d, [600, 10]), 0);
console.log("layout: ok");
