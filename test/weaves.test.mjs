// The weave library (`tools/weaves.py`): every weaves.json entry has its three 512 x 512 tiles,
// every value is labelled "(estimated)", and every tile wraps without a seam. The PNGs are read
// with node:zlib alone (8-bit RGB or RGBA, no interlace: what Pillow writes).
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "weaves");
const lib = JSON.parse(readFileSync(join(dir, "weaves.json"), "utf8"));
const EST = "(estimated)";
const KINDS = ["diffuse", "normal", "roughness"];
const NAMES = ["plain", "twill", "denim", "jersey", "rib", "fleece", "satin", "canvas"];

assert.equal(lib.version, 1);
assert.ok(lib.note.includes(EST), "the note is labelled");
assert.deepEqual(Object.keys(lib.weaves).sort(), [...NAMES].sort());

// width, height, channels and the unfiltered pixels of an 8-bit RGB(A) PNG
function decode(bytes) {
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
    let at = 8, ihdr, idat = [];
    while (at < bytes.length) {
        const len = bytes.readUInt32BE(at), type = bytes.toString("latin1", at + 4, at + 8);
        const data = bytes.subarray(at + 8, at + 8 + len);
        if (type === "IHDR") ihdr = data;
        else if (type === "IDAT") idat.push(data);
        at += 12 + len;
    }
    const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
    const depth = ihdr[8], colour = ihdr[9], interlace = ihdr[12];
    assert.equal(depth, 8, "8-bit");
    assert.ok(colour === 2 || colour === 6, `RGB(A), colour type ${colour}`);
    assert.equal(interlace, 0, "not interlaced");
    const ch = colour === 6 ? 4 : 3, stride = width * ch;
    const raw = inflateSync(Buffer.concat(idat));
    const px = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? px[row + x - ch] : 0;
            const b = y > 0 ? px[row - stride + x] : 0;
            const c = x >= ch && y > 0 ? px[row - stride + x - ch] : 0;
            let p = raw[src + x];
            if (f === 1) p += a;
            else if (f === 2) p += b;
            else if (f === 3) p += (a + b) >> 1;
            else if (f === 4) {
                const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
                p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            } else assert.equal(f, 0, `filter ${f}`);
            px[row + x] = p & 255;
        }
    }
    return { width, height, ch, px };
}

// mean |difference| across the wrap seam (last column to first, last row to first) against the
// mean between interior neighbours, over the RGB channels: the worst of the two ratios
function seamRatio({ width, height, ch, px }) {
    const at = (x, y, k) => px[(y * width + x) * ch + k];
    let innerC = 0, seamC = 0, innerR = 0, seamR = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) {
        const v = at(x, y, k);
        if (x + 1 < width) innerC += Math.abs(at(x + 1, y, k) - v); else seamC += Math.abs(at(0, y, k) - v);
        if (y + 1 < height) innerR += Math.abs(at(x, y + 1, k) - v); else seamR += Math.abs(at(x, 0, k) - v);
    }
    innerC /= (width - 1) * height * 3; seamC /= height * 3;
    innerR /= width * (height - 1) * 3; seamR /= width * 3;
    const ratio = (s, i) => (i > 0 ? s / i : s > 0 ? Infinity : 0);
    return Math.max(ratio(seamC, innerC), ratio(seamR, innerR));
}

let files = 0, worst = 0;
for (const [name, w] of Object.entries(lib.weaves)) {
    assert.equal(w.estimated, EST, `${name} is labelled ${EST}`);
    assert.equal(typeof w.label, "string");
    assert.ok(Array.isArray(w.tile_mm) && w.tile_mm.length === 2 && w.tile_mm.every((v) => v > 0), `${name} tile_mm`);
    assert.ok(w.roughness > 0 && w.roughness <= 1, `${name} roughness`);
    assert.match(w.sheen, /^#[0-9a-f]{6}$/, `${name} sheen`);
    assert.ok(w.sheen_roughness > 0 && w.sheen_roughness <= 1, `${name} sheen_roughness`);
    for (const kind of KINDS) {
        const path = join(dir, `${name}-${kind}.png`);
        assert.ok(existsSync(path), `${name}-${kind}.png exists`);
        const bytes = readFileSync(path);
        // IHDR first, straight after the signature: 512 x 512
        assert.equal(bytes.toString("latin1", 12, 16), "IHDR");
        assert.equal(bytes.readUInt32BE(16), 512, `${name}-${kind} width`);
        assert.equal(bytes.readUInt32BE(20), 512, `${name}-${kind} height`);
        const img = decode(bytes);
        const r = seamRatio(img);
        assert.ok(r <= 1.5, `${name}-${kind}: the wrap seam is ${r.toFixed(2)} x the interior`);
        worst = Math.max(worst, r);
        if (kind === "roughness") {
            // glTF layout: R 255, B 0, G the roughness near the weave's default
            let g = 0;
            for (let i = 0; i < img.px.length; i += img.ch) {
                assert.equal(img.px[i], 255); assert.equal(img.px[i + 2], 0);
                g += img.px[i + 1];
            }
            g /= img.px.length / img.ch;
            assert.ok(Math.abs(g / 255 - w.roughness) < 0.03, `${name} mean roughness ${g / 255} vs ${w.roughness}`);
        }
        files++;
    }
}
assert.equal(files, NAMES.length * 3);
console.log(`weaves: ${files} tiles, worst seam ratio ${worst.toFixed(2)}`);
