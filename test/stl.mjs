// A read scene's triangles as a binary STL (the test fixtures: an STL avatar made from a STEP
// one through the kernel's reader). Normals are left zero: readers recompute them.
export function stlOf(scene) {
    const v = scene.vertices(), o = scene.origin(), idx = scene.indices(), n = idx.length / 3;
    const buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
    dv.setUint32(80, n, true);
    for (let t = 0; t < n; t++) {
        const at = 84 + 50 * t + 12;
        for (let c = 0; c < 3; c++)
            for (let a = 0; a < 3; a++) dv.setFloat32(at + 12 * c + 4 * a, v[9 * idx[3 * t + c] + a] + o[a], true);
    }
    return new Uint8Array(buf);
}
