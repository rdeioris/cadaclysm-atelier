# Cadaclysm Atelier

Atelier is a garment-design web app built on the cadaclysm kernel's web package: you draw flat
pattern pieces, join them with seams, and see the garment, in plain ES modules with no bundler.

    npm install
    npm run setup -- --pkg <folder>     # the web package's pkg/ folder: see "The package"
    npm start                           # http://localhost:8141/
    npm test
    npm run test:browser                # the page end to end in headless Chrome or Edge

**Sample: T-shirt** in the menu opens `assets/tshirt.json`: front, back and two sleeves in
cotton jersey, sewn and placed around the f-M dress form (a women's M: chest 920 mm, body
length 650 mm, sleeve length 200 mm). `node tools/make-sample.mjs` writes it through the
kernel and checks that every seam's two sides match within 2 %. Its front and back stand
about 50 mm clear of the form and its sleeves are wrapped round the form's arms, so the cloth
sews it shut before it drapes.

**Forms.** The Avatar's Form select offers the dress forms in `assets/forms.json`: f-M,
f-M with head (`tools/dressform.py --head`), and the graded sizes Women's XS, S, L, XL and
Men's XS, S, M, L, XL (f-XS ... m-XL), each graded from its size chart by `tools/dressform.py
--body {female,male} --size ...`. Their landmarks come from the same script with
`--forms-only --forms assets/forms.json`, never typed by hand. The file also carries each form's landmarks (body
top, shoulder line, arms, head), which the slots place pieces by. The form is the session's,
not the garment's: Save does not write it, and Open keeps the avatar that is loaded.

## The package

`npm run setup` puts the cadaclysm web package's `pkg/` folder (the kernel and the View as
WebAssembly, and their JavaScript) beside the app as `./pkg`. The 2D window needs the View's
picking and snapping and the kernel's `document_clear_history`, and no release carries them
before 0.16. Until then, build the web package from cadaclysm master (`build_pkg` in its
`scripts/www-forge.py`, or the site build, which builds the same folder) and pass the folder:

    npm run setup -- --pkg <folder>

`--zip <package.zip>` takes a web package zip instead. Setup refuses a package that lacks what
the app calls, and names what is missing. From 0.16, `npm run setup` alone fetches the release.

## The 2D window

One View draws both windows: the 3D window (viewport 0) and the 2D pattern window (viewport 1).
In the 2D window the wheel zooms, a middle or right drag (or Space and a left drag) pans, and
**F** or **Fit** frames the pieces. **F2** / **F3** maximise the 2D / 3D window.

- **Snapping** while drawing: to ends, vertices, notches, midpoints, intersections, quadrants
  and edges, with alignment guides through the points already placed; to the 10 mm grid with
  **Grid** on. Holding **Shift** after a placed point locks the angle to 45 degree steps.
- **Typed lengths**: while a shape has a last point, typing a number opens a length box at the
  pointer; **Tab** goes to the angle (blank: toward the pointer), **Enter** places the point as
  a click would, **Escape** closes the box and the shape goes on.
- **Box select**: a drag on empty space in **Edit** selects points, in **Move** pieces. Left to
  right is a window (only what lies wholly inside), right to left a crossing box (anything it
  touches).

The tools, with their keys where they have one:

- **Rect** (S), **Polygon** (H) and **Ellipse** (E): an ellipse drags corner to corner, Shift
  for a circle; a click without a drag asks for its size (so does a rectangle's).
- **Internal** (G) draws an internal line on the selected piece as **Polygon** draws: a click
  places a corner, a drag places a curve point with mirrored handles; Enter or a double click
  ends it (Backspace drops the last point). **Int □**, **Int ○** and **Int ⬠** draw an internal
  rectangle, ellipse or polygon. In **Edit**, the selected piece shows its internal lines' points
  (hollow squares) and Bézier handles (hollow diamonds): a drag moves one, the handles on either
  side of a point riding along; each drag is one undo step.
- **Hole □**, **Hole ○** and **Hole ⬠** cut a rectangular, elliptical or polygonal hole in a
  piece; **To hole** turns an internal closed shape into a hole.
- **Cut** splits a piece along an internal line, or along a cutter drawn across the selected
  piece (Enter ends it): two pieces with the same fabric, grain, allowance and layer; seams,
  notches and internal shapes go with the half they lie on (a seam split by the cut is dropped,
  and the status names it). **Cut & sew** also sews the two new edges.
- **Trace** copies an internal closed shape out as a new piece.
- **Fillet** rounds a corner: click it, then drag or type the radius.
- **Ruler** (R) measures in 2D: two clicks (snapping on, **Shift** for 45° steps) give the
  straight distance, drawn as a line with its length (mm, to 0.1 mm); a click on an edge gives
  that side's arc length (a click snapped to a vertex, an end or an intersection starts a
  two-click measure instead). The measures stay until **Escape** or another tool, and are never
  saved. In **Edit**, hovering an edge names its side's length on the status line.
- **Edit** (Z) and **Move** (A) as before; **Sew sides** (N), **Sew free** (M). A move carries
  the whole piece: its internal lines, notches and grain go with the outline. With pieces
  selected, **Move** draws their bounds box: a corner handle scales uniformly about the opposite
  corner, a side handle scales one axis about the opposite side, and the round handle above the
  top side rotates about the box centre (**Shift**: 15° steps). Each drag is one undo step, the
  seams re-anchored.
- The pattern panel's **Rotate** (degrees, counter-clockwise), **Scale** (%), **Flip H** and
  **Flip V** turn the selected pieces about their bounds' centre (a multi-selection's union), one
  undo step each, the seams re-anchored to the new sides; a scale keeps the allowances.
- **Ctrl+C** copies the selected pieces, with the seams between them, to the app's own clipboard;
  **Ctrl+V** pastes them 30 mm along x and y as "‹label› copy" (each further paste 30 mm more),
  off their slots; **Ctrl+D** (and the panel's **Duplicate**) copies and pastes in one step.
- **Points** in **Edit**: a double click on an outline edge adds a point there; **Delete** (or
  **Backspace**) removes the selected points in one undo step; a right click on a point opens a
  menu with **Make curve point** / **Make corner**, and **C** toggles the selected points between
  the two. A point the kernel refuses (one that would leave too few sides, say) changes nothing,
  and the status names it. Seams stay on their sides; notches keep their place along the outline.
- **Notch** places a notch on an edge, of the kind and depth last chosen (a slit, 6 mm deep, at
  first). The 2D window draws each of the five kinds as cut: **Slit**, **V**, **T**, **Castle**
  and **U**. A click on a notch in **Edit** selects it; the panel then sets its **Kind**,
  **Depth** (mm) and **At** (mm along the outline) or removes it, and the kind and depth set
  there become the Notch tool's next ones.
- **Sym** makes a symmetric pair: on the selected piece two clicks give an axis, as **Mirror**
  does, and the mirrored copy is added, linked. An edit of either piece rebuilds the other
  (outline, holes, internal lines, notches, grain) in the same undo step, live during a drag;
  moving one moves the other the mirrored way, and moving both moves the pair as one. The
  panel's **Unlink** (on either piece) makes them independent; deleting one unlinks the other,
  and **Cut** unlinks first.
- **Unfold** makes a piece whole: a click on a straight side takes it as the fold, and the piece
  becomes the half plus its mirror, the fold drawn dashed across it. Editing either half rebuilds
  the whole from that half (the fold's two ends slide only along the fold). The panel's **Fold
  back** returns the half, with its own internal lines and notches (seams on the mirrored side
  are dropped, and the status names them); **Unlink** keeps the whole as an ordinary piece.

**Slots**: Front, Back, the sides and arms; Hood left / Hood right beside the head of a form
that has one; **On <piece>** puts a piece on another (its frame and wrap, 8 mm out a layer).
**Arrange** puts each unplaced piece in the next free named slot (the hood slots last); it
never puts a piece on another one: that is the Slot select's pick.

## Live drape

**Simulate** in the 3D strip meshes the garment and runs the kernel's cloth solver on it: the
shirt sews with gravity off until every seam is closed (or 60 frames), then drapes onto the
avatar. **Pause** stops it, **Reset** drops the cloth and brings the flat pieces back.

- **Engine**: on a WebGPU browser the cloth steps on the View's GPU (`gpu-drape.js`, in the View's
  worker), at about 28 frames a second for the sample T-shirt in Chrome on an RTX 3070 (2 on the
  CPU worker; `ATELIER_FPS=1 node test/browser.mjs` measures it). Elsewhere (WebGL2), or
  with `?cloth=cpu` in the URL, it steps on the CPU in a worker of its own (`cloth-worker.js`).
  The 3D strip says which: `GPU · GIA on` (the default; the GIA button turns it off),
  `GPU · GIA off` or `CPU`.

- **Pin**: click the cloth to pin the nearest point where it is; click it again to unpin.
- **Drag**: press on the cloth and pull; the point follows the pointer on the plane facing the
  camera. Right or middle drag and the wheel still move the camera while a tool is on.
- **Editing while it runs**: a 2D edit of an outline, a grain, a piece's Mesh (its own particle
  distance, 10 to 40 mm; empty is the garment's 20 mm) or a seam's range re-meshes that piece and
  keeps the drape (also live, during a 2D drag). Pieces sewn together must be within 2x of each
  other's Mesh: the drape refuses a seam past that, and the strip shows why. A 2D move of a piece changes nothing
  in 3D. Adding or removing a piece, seam or fabric, a fabric's values or a new avatar make the
  cloth stale: the strip says so, and Simulate (paused) rebuilds it.
- **Health**: the strip shows the frame, the phase, the welded seam pairs, the mesh size and the
  fastest particle; the footer the simulated frames per second and the time a step takes. A
  particle going non-finite or faster than 50 m/s, or a step taking over 5 s, pauses the cloth.
- `node tools/drape-probe.mjs [garment.json] [frames] [every]` steps a garment's cloth in Node
  and prints its health: a quick look at whether it sews and drapes, without the page.

**Film hook** (`film.js`) — `?film=1` is for the tutorial video's driver: Simulate builds the
cloth paused (and then does nothing to it), `atelierFilm.step(n)` steps exactly n frames and
resolves once the View has drawn the last (steps queue), `atelierFilm.run()` / `pause()` run free
and stop, `atelierFilm.garment()` reads the document without a download,
`atelierFilm.viewStats()` the View's counters, `atelierFilm.stops` counts the cloth's stops,
`atelierFilm.log` holds each frame's time. Nothing in the UI uses it.

## Limitations (preview)

- On the CPU the drape runs at 2-5 frames a second; the View draws at the display rate
  meanwhile and the cloth moves as frames arrive.
- On the GPU the cloth is one View item, coloured per vertex: each piece in its own fabric's
  colour (the fit map, when on, recolours it). Unlike the CPU cloth, it does not take the
  selection accent.
- Box select in **Edit** picks the selected piece's outline points only, not its internal lines'
  points or handles.
- **Unfold** renumbers the piece: the whole starts where the fold side ended, so its sides
  (and the point numbers in status messages) are not the half's old ones.
- An edit that changes both halves of an unfolded piece at once (points on either side of the
  fold moved together) keeps the first half's change and rebuilds the other half from it.
  Internal lines and notches added to the whole are not mirrored.
- **Sym** refuses a piece that is linked or unfolded already; **Unfold** refuses a linked piece,
  an unfolded one, a curved side and a piece of fewer than three sides (the status says which).
- On the GPU the global intersection analysis (GIA) is on by default, as in the View; the GIA
  button turns it off (faster a frame) and back on. The CPU path always runs it.
- On the GPU a seam's weld lands up to about 2 frames later than on the CPU (it waits for the
  View's next round trip).
- A settled shirt still has a few particles jittering at 2-10 m/s (the health line's max speed).
- Before Simulate the 3D window draws each piece flat at its frame: a sleeve wrapped round an
  arm shows as a flat slab along the arm until the cloth is built.
- On a form with landmarks (assets/forms.json) the arm slots wrap a sleeve round the arm and the
  front and back hang from the shoulder line; on any other STEP avatar the slots are the old
  fractions of its bounds.
- DXF import brings in outlines, allowances, grain lines and notches. Internal lines and holes
  are dropped (the kernel has no getter for them yet; DXF export writes holes), and so are the
  3D slots: imported pieces lie on the floor until arranged.
- Holes: a hole's points cannot be moved and its edges cannot be sewn yet. A hole smaller than
  twice the allowance gets no cut line (the status bar says so); a hole's cut line uses the
  piece's first allowance.
- Fillet arcs are locked in Edit: to change a radius, undo and fillet again. Conic weights (an
  ellipse's) are not editable.
- Cut gives both pieces the first width of a per-side allowance. A cut that crosses a hole or
  an internal line is refused: move or delete it first.
- The 2D window draws seam lines 1 px wide (the View has no line width yet), and piece fills are
  opaque and the length read-out a label until the View's regions and dimensions land.
- The sample's sleeve caps have zero ease: each cap half is exactly as long as its armhole.
- A slot can name what is gone: "On <piece>" after that piece is removed, or a hood slot after
  switching to a form with no head. The piece keeps its frame and the Slot select shows the
  stale value until another slot is picked.
- Slot frames go stale: after a 2D move or edit, or a new avatar, a placed piece drifts off its slot.
- Avatars are STEP only. STL dress forms wait for the kernel's STL reader.
- Forms with a head: only f-M so far.
- Fabric presets come from published KES-F measurements: the sources and the conversion are in
  [docs/fabric-sources.md](docs/fabric-sources.md). Many sources publish one value for both
  directions, so warp and weft (and the biases) often carry the same number.
- Buckling stiffness is a ratio of the bending stiffness (0 to 1, 0.5 in every preset), as the kernel
  reads it; documents saved with the old absolute value (> 1) get the ratio when opened.
- One preset is an estimate, not a measurement: "Cotton fleece (estimated)" (sweatshirt fleece for
  the hoodie) is cotton jersey scaled to 300 g/m², 1.5 mm, because no published KES-F data for fleece was found.
