// Puts the cadaclysm web package's pkg/ folder -- the WebAssembly module (the kernel and the
// View), its loader and the SDK's JavaScript wrapper -- here, as ./pkg. Not committed: it
// is the closed-source part, fetched from the SDK's releases.
//
//     npm run setup                          # the release pinned below, from GitHub
//     npm run setup -- --zip <package.zip>   # a package zip you already have
//     npm run setup -- --pkg <folder>        # a pkg/ folder (a local build of the package)
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

// The release whose web package Atelier is built against. The 2D window needs the View's
// picking and snapping (view ABI 1.30) and the kernel's document_clear_history, which 0.16 is
// the first release to carry; --pkg <folder> still takes a kernel+view build of cadaclysm master.
const VERSION = "0.16.0";
const ASSET = VERSION && `cadaclysm-${VERSION}-web.zip`;
const URL = VERSION && `https://github.com/rdeioris/cadaclysm-sdk/releases/download/v${VERSION}/${ASSET}`;
// Names the package must carry: the View's 1.30 calls, the kernel's fresh history and the
// simulation controls (saved options and pins, Freeze on the CPU and the GPU cloth), which no
// release carries yet: until one does, --pkg <a cadaclysm master build>.
const CARRIES = ["pickRect", "setSnapBase", "cadaclysm_blacksmith_document_clear_history", "cadaclysm_blacksmith_document_head",
    "cadaclysm_blacksmith_garment_sim_options", "cadaclysm_blacksmith_cloth_freeze", "freezeCloth"];
// What Atelier loads from the package.
const NEEDED = ["cadaclysm.js", "cadaclysm_bg.wasm", "index.js", "view.js"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "pkg");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// The zip's pkg/ folder (`cadaclysm-<version>-web/pkg/...`): its files by their path in it.
function pkgOfZip(bytes) {
    const found = new Map();
    for (const [name, data] of Object.entries(unzipSync(new Uint8Array(bytes)))) {
        const m = /^[^/]+\/pkg\/(.+[^/])$/.exec(name);
        if (m) found.set(m[1], data);
    }
    return found;
}

// A folder's files by their path in it.
function filesOf(folder, at = folder, found = new Map()) {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) filesOf(folder, path, found);
        else found.set(relative(folder, path).replace(/\\/g, "/"), readFileSync(path));
    }
    return found;
}

async function main() {
    let files, from;
    const folder = option("--pkg"), zip = option("--zip");
    if (folder) {
        files = filesOf(folder);
        from = folder;
    } else {
        let bytes;
        if (zip) bytes = readFileSync(zip);
        else {
            if (!VERSION) throw new Error("no release carries what Atelier needs yet (the View's picking and snapping, document_clear_history): npm run setup -- --pkg <folder> (README, \"The package\")");
            console.log(`fetching ${URL}`);
            const response = await fetch(URL);
            if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${URL}`);
            bytes = await response.arrayBuffer();
        }
        files = pkgOfZip(bytes);
        from = zip ?? ASSET;
    }
    const missing = NEEDED.filter((f) => !files.has(f));
    if (missing.length) throw new Error(`${from} has no ${missing.join(", ")}: Atelier needs the web package's pkg/ (the kernel and the View)`);
    const glue = new TextDecoder().decode(files.get("cadaclysm.js"));
    const lacks = CARRIES.filter((n) => !glue.includes(n));
    if (lacks.length) throw new Error(`${from} predates ${lacks.join(", ")}: build the package from cadaclysm master (README, "The package")`);
    // Written beside, then swapped in: a failed setup leaves the pkg/ there was.
    const next = `${out}.next`;
    rmSync(next, { recursive: true, force: true });
    for (const [name, data] of files) {
        mkdirSync(dirname(join(next, name)), { recursive: true });
        writeFileSync(join(next, name), data);
    }
    rmSync(out, { recursive: true, force: true });
    renameSync(next, out);
    console.log(`pkg/ from ${from}: ${(statSync(join(out, "cadaclysm_bg.wasm")).size / 1048576).toFixed(2)} MB of wasm`);
}

main().catch((e) => {
    console.error(`setup: ${e.message}`);
    if (!option("--pkg") && !option("--zip")) console.error("(a package you already have: npm run setup -- --zip <package.zip>, or -- --pkg <folder>)");
    process.exit(1);
});
