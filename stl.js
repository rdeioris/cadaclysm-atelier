// An STL file (binary or ASCII) as the mesh the View shows: the web reader has no STL, so the
// avatar's STL is read here. Flat: three vertices and a face normal per triangle.
export function parseStl(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let tri;
    if (u8.length >= 84 && 84 + 50 * dv.getUint32(80, true) === u8.length) {
        const n = dv.getUint32(80, true);
        tri = new Float64Array(n * 9);
        for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) tri[t * 9 + k] = dv.getFloat32(84 + 50 * t + 12 + 4 * k, true);
    } else {
        const nums = [];
        for (const m of new TextDecoder().decode(u8).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
        if (!nums.length || nums.length % 9 || nums.some((v) => !Number.isFinite(v))) throw new Error("not an STL file");
        tri = Float64Array.from(nums);
    }
    const n = tri.length / 9;
    if (!n) throw new Error("the STL has no triangles");
    const positions = new Float32Array(tri), normals = new Float32Array(n * 9), indices = new Uint32Array(n * 3);
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let t = 0; t < n; t++) {
        const o = t * 9;
        const u = [0, 1, 2].map((a) => tri[o + 3 + a] - tri[o + a]), v = [0, 1, 2].map((a) => tri[o + 6 + a] - tri[o + a]);
        const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(...c) || 1;
        for (let k = 0; k < 3; k++) { for (let a = 0; a < 3; a++) normals[o + 3 * k + a] = c[a] / l; indices[t * 3 + k] = t * 3 + k; }
        for (let i = 0; i < 9; i++) { const a = i % 3; if (tri[o + i] < bounds[a]) bounds[a] = tri[o + i]; if (tri[o + i] > bounds[a + 3]) bounds[a + 3] = tri[o + i]; }
    }
    return { positions, normals, indices, bounds };
}
