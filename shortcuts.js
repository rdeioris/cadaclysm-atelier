// CLO's default shortcuts as far as we know them; correct against CLO here.
// A map from key to {tool} or {command}. Notch, dart, mirror, allowance and grain have no key.

export const SHORTCUTS = {
    A: { tool: "transform" },
    Z: { tool: "edit" },
    S: { tool: "rectangle" },
    H: { tool: "polygon" },
    G: { tool: "internal" },
    N: { tool: "segment" },
    E: { tool: "ellipse" },
    M: { tool: "free" },
    B: { tool: "sewmn" },
    R: { tool: "ruler" },
    "Ctrl+Z": { command: "undo" },
    "Ctrl+Y": { command: "redo" },
    "Ctrl+S": { command: "save" },
    "Ctrl+O": { command: "open" },
    // the in-app clipboard (not the system one): the selected pieces and their inner seams
    "Ctrl+C": { command: "copy" },
    "Ctrl+V": { command: "paste" },
    "Ctrl+D": { command: "duplicate" },
    F2: { command: "maximise2d" },
    F3: { command: "maximise3d" },
};

// e is a KeyboardEvent (or {key, ctrlKey, metaKey}); null when the key has no meaning.
export function toolOfKey(e) {
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const name = (e.ctrlKey || e.metaKey ? "Ctrl+" : "") + k;
    return Object.hasOwn(SHORTCUTS, name) ? { ...SHORTCUTS[name] } : null;
}
