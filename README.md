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
**Avatar** also loads a dress form of your own, a STEP (`.stp`, `.step`) or an STL (`.stl`, read
as a mesh); its triangles are the cloth's collider either way. Such a file has no landmarks.

**Weaves.** `assets/weaves/` holds the weave library: plain, twill, denim, jersey, rib, fleece,
satin and canvas, each a seamless 512 x 512 diffuse (near-white: the fabric colour tints it),
normal (OpenGL, green up) and roughness (glTF: roughness in G) tile, with `weaves.json` giving
each tile's size in mm and its default roughness and sheen. The tiles are procedural, from each
weave's structure, and every value is an estimate. `python tools/weaves.py` (numpy and Pillow)
regenerates them; `python tools/weaves.py --check` compares a regeneration with the files and
checks the seams, the diffuse bounds, the normals' length and the labels.

## The package

`npm run setup` puts the cadaclysm web package's `pkg/` folder (the kernel and the View as
WebAssembly, and their JavaScript) beside the app as `./pkg`. The 2D window needs the View's
picking and snapping and the kernel's `document_clear_history`, and no release carries them
before 0.16. Until then, build the web package from cadaclysm master (`build_pkg` in its
`scripts/www-forge.py`, or the site build, which builds the same folder) and pass the folder:

    npm run setup -- --pkg <folder>

`--zip <package.zip>` takes a web package zip instead. Setup refuses a package that lacks what
the app calls, and names what is missing. The simulation controls (saved options and pins,
Freeze) need calls no release carries yet (0.16 does not): until one does, build the package
from cadaclysm master and pass `--pkg`.

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
- **Sew M:N** (B) sews several ranges to several: pick side A's ranges (a click on a side takes
  the whole side, running away from the end nearer the click; **Shift** and two clicks take a
  free range, first click to second), **Enter**, side B's the same way, **Enter** sews.
  **Backspace** drops the last range, **Escape** cancels. A's ranges end to end map onto B's end
  to end by length; every range end on either side cuts the run, and each piece is one 1:1 seam
  (at most M + N - 1). The group is re-distributed after every edit of its pieces (one undo step
  with the edit); a piece cut, or a range's side gone, leaves its seams as plain ones. Selecting
  one of its seams selects the group (one colour, numbered n.1, n.2, ...): the panel shows its
  ranges and lengths, **Ungroup** (the seams stay as plain 1:1 seams) and **Remove group**;
  **Delete** removes it whole.
- **Sewing hole edges**: **Sew sides**, **Sew free** and **Sew M:N** sew a hole's edge as they
  sew an outline's (a sleeve sewn into an armhole cut as a hole, say). A click on a hole takes
  that hole's side (a hole's sides are its own segments: an ellipse hole has four); **Shift** and
  two clicks on the same hole take a free range on it. The seam is drawn on the hole's edge in
  its colour, and its panel names the hole ("a on: hole 1"). A point added to or removed from the
  outline, a fillet, a move or a transform leave a hole seam on its hole; a **Cut** beside the
  hole takes the seam with the hole to its half; **Fold back** drops a seam on a mirrored hole
  (the status names it). In the file a seam end on a hole carries `a_loop`/`b_loop` (hole k is
  loop k; the outline is loop 0, written as nothing).
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
A placed piece stays on its slot: a 2D edit, move or transform of it re-places it in the same
undo step (a 2D move re-centres it there; it does not move it in 3D), and the pieces on it
follow. A new avatar re-places every placed piece, one undo step ("re-arrange on the form").
**Place** in the 3D strip (place on avatar): with a piece selected, a click on the avatar puts
it there, its centre over the point, standing 30 mm out along the body's normal (8 mm more a
layer), its y the world's up (the camera's up on a near-horizontal surface such as a shoulder's
top). With **Wrap** on (the default) a click on an arm wraps the piece round that arm, as the arm
slots do. The Slot select shows such a piece as **On avatar**; it is refreshed like any slot.
**The gizmo**: with one placed piece selected and no cloth, the 3D window draws a gizmo over it
(at its centre; a sleeve's on its wrap axis). Drag an arrow to move the piece along world X, Y
or Z, a ring to turn it about its own normal, x or y, the centre square to move it in the
camera's plane; **Shift** snaps to 10 mm and 15°, **Escape** cancels the drag. A wrapped piece's
wrap axis moves and turns with it. The release is one undo step; the piece's slot becomes
**Custom (3D)**, and the pieces on it follow. A new avatar leaves a custom piece where it is; a
2D edit, move or transform of it keeps its frame's axes and its centre's place in 3D (the frame
shifts so the piece's bounds centre stays on its 3D point; a wrapped piece keeps its wrap and the
shift goes round the limb and along it), in the edit's undo step.

## Grading

You draft one size, the **base**, and grade the others from it by rules on the outline's points,
as in CLO. The size table and the rules are in the document (Save and Open keep them); an older
Atelier opening a graded file sees the current size alone.

- **Sizes…** in the 2D strip opens the size table: add a size (type its name, Enter), rename
  one, move it earlier or later, remove it (its rules go with it), and choose the **base**.
  Each change is one undo step. A new base re-expresses every rule against it, and its outline
  becomes the drafted one. The first size added is the base.
- **The size select** beside it lists the sizes, the base marked. Picking one switches every
  graded piece in one undo step ("size L"): each outline becomes its base with every point moved
  by its rule for that size, its Bézier handles with it. Notches keep their fraction of their
  side, internal lines follow the least-squares affine fit of the points' moves, seams stay on
  their sides (M:N groups re-distribute), placed pieces stay on their slots, and a linked
  partner or an unfolded whole is rebuilt from its half. A size the kernel refuses (an outline
  that would cross itself) changes nothing, and the status names the piece.
- **Editing in the base size** works as before: the base follows each edit, and a point added
  or removed shifts the rules (a new point on a side takes the rule between its neighbours).
  **Cut** and **Cut & sew** grade both new pieces: a point on an old point takes its rule, one on
  a side the rules interpolated along it, a cutter's bend inside the piece the affine fit.
- **In another size** an **Edit** drag of an outline point (or a side) sets the moved points'
  rules for that size: the new place minus the base's. Every other change of the shape is
  refused with "edit the shape in the base size (M)": a handle (refused at the press), adding,
  removing or smoothing a point, Fillet and Cut. Internal lines, notches and seams stay editable.
- **The grade table**: with one outline point selected (Edit), the panel lists every size's
  dx and dy (mm), the base row fixed at 0, 0 and the current size marked; typing into a row
  sets that rule, one undo step. With several points selected, **Copy rule to…** copies the
  chosen point's rules (every size) to the others, and with two, **Distribute** gives the points
  between them (the shorter way round) rules interpolated by length along the outline, every
  size. **Proportional…** (any selection) asks for a width and height change per size step,
  20 mm and 10 mm say, and grades every point of the selected pieces by its place from their
  bounds' centre, scaled by the steps from the base.
- **Show sizes** draws every other size's outline of the selected pieces at once, dashed and
  thin in a ramp of the accent (the smallest faintest), over the current outline: CLO's graded
  nest. It is computed as a switch would be, without committing, and is not saved.

Limits: holes are not graded (they keep the base size in every size); an arc whose two ends
have different rules may be refused (its centre moves by their mean, which the kernel's checks
may not accept); a mirroring transform (Flip, Mirror) in a size
other than the base may be refused; Show sizes draws a linked partner or an unfolded whole in
the sizes it has been switched to since it was made (its rules are recorded per size from its
half); DXF export writes the current size only.

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

### Simulation controls

- **Simulation** panel (the foot of the browser): the cloth's 20 options in friendly units
  (gravity in m/s², stiffness in N/m, the frame in ms). A change is saved with the garment
  (`garment.garment`'s `sim_options`, only what differs from the default) and applied to a
  running cloth at once; a new particle distance rebuilds it (Simulate). Sewing still runs
  with gravity off and a stalled sewing still gets a wider weld, on top of the saved values.
  **Reset to defaults** clears them.
- **Piece** properties: **Freeze** (the piece holds still, the others collide with it; live),
  **Strengthen** (its stretch and bending ×), **Pressure** (Pa, along its front side), and its
  saved pins (**Clear pins**).
- **Fabric**: **Shrinkage warp / weft** in CLO's percent (100 none, 95 shrinks 5 %).
- **Seam**: **Strengthen** (the bending across it), **Elastic** (its rest length in % of the
  seam's) and its stiffness in N per unit strain (empty: 2 N, an estimate).
- **Internal line** (click one in Edit): its kind (line, fold, dart); a fold's **angle** (CLO's:
  180 flat, 0 folded shut toward the front, 360 toward the back) and strength; an elastic.
- **Fold** (2D strip): an internal fold line; click points on a piece, Enter ends it.
  **Tack**: click a point on a piece, then one on the same or another piece; the tack (a
  dashed line with two dots) closes and welds the two points as a seam does. Select it to
  edit its ends; Delete removes it.
- **Pins** made with the Pin tool are saved on their piece (pattern space, `pins`); Unpin
  removes them; Open and Simulate pin them again.
- On a running cloth a piece's Strengthen or Pressure, a fold or an elastic's numbers, a
  fabric's shrinkage or a tack's ends re-mesh the pieces they touch; adding or removing a tack
  or an elastic makes the cloth stale (Simulate rebuilds).

### Darts and pleats

- **Dart** (2D strip) draws a dart as before: two clicks on one edge, then the apex. Select it (a
  click on it in **Edit**) and its panel offers:
  - **Close (cut)**: the wedge leaves the piece, its two legs become outline and a seam sews them;
  - **Close (fold)**: the wedge stays, folded under: the legs become lines tacked together at the
    particle spacing, the centre line a fold at 360°;
  - **Rotate…**: point at the outline where the dart should go (the piece previews the dart
    moved there, the stretch between pivoting on the apex) and click; **Escape** cancels.
  Each is one undo step. A dart the kernel refuses (a rotation onto a seam's range or into the
  dart itself, say) changes nothing, and the status line names the fault.
- **Pleat** (2D strip): drag the placement line on a piece, from the edge that gets the top
  tacks (the waist) toward the hem, then drag across the area to pleat. The panel then sets the
  count, the depth (a knife pleat takes in twice it, a box pleat four times), knife or box, the
  way a knife pleat faces and the top tack; the piece previews the fold lines as they change.
  **Enter** adds them (one undo step), **Escape** drops them. The folds start folded in the
  cloth (pre-folded), and the top tacks hold each pleat closed at the waist.
- **A pleat group**: a click on one of its folds selects the whole set (drawn in the accent); its
  panel edits the numbers (the set removed and added again, one undo step), **Remove pleats** or
  **Delete** removes the folds and their tacks together.
- All of it is the kernel's (`garment_close_dart_cut`, `_folded`, `garment_rotate_dart`,
  `garment_add_pleats`, `garment_remove_pleats`) run on a copy of the garment; the result is
  written into the document as ordinary nodes (outline, internal lines, notches, seams, tacks, and
  the pattern's `pleats`). Closing a dart or adding pleats makes a running cloth stale (Simulate
  rebuilds it); a rotated dart re-meshes the piece.
- Limits: dart and pleat edits are made in the base size of a graded garment; a piece's outline
  elastics (not a seam's) are not carried through a dart edit that moves the outline.

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
- On a form with landmarks (assets/forms.json) the arm slots wrap a sleeve round the arm and the
  front and back hang from the shoulder line; on any other avatar (a STEP or STL of your own)
  the slots are the fractions of its bounds.
- DXF import brings in outlines, holes, allowances, grain lines, notches, internal lines and
  folds. A dart comes back as a plain internal line, and the 3D slots are not in the file:
  imported pieces lie on the floor until arranged.
- The gizmo's size follows the piece (0.45 of its larger 2D side, 80 to 260 mm), not the
  camera: zoomed far out it is small, zoomed in on a big piece it can run off the window.
- A gizmo ring seen edge on (its axis across the view) turns by the pointer's travel along the
  ring's tangent at the grabbed point: an approximation, less exact than a ring facing the camera.
- The gizmo answers a press only once the hover pick has named the part under the pointer (one
  round trip to the View's worker): a press made before that answer orbits the camera instead.
- Holes: a hole's points cannot be moved (so a hole seam's sides never change). A hole smaller than
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
- Forms with a head: only f-M so far.
- Fabric presets come from published KES-F measurements: the sources and the conversion are in
  [docs/fabric-sources.md](docs/fabric-sources.md). Many sources publish one value for both
  directions, so warp and weft (and the biases) often carry the same number.
- Buckling stiffness is a ratio of the bending stiffness (0 to 1, 0.5 in every preset), as the kernel
  reads it; documents saved with the old absolute value (> 1) get the ratio when opened.
- One preset is an estimate, not a measurement: "Cotton fleece (estimated)" (sweatshirt fleece for
  the hoodie) is cotton jersey scaled to 300 g/m², 1.5 mm, because no published KES-F data for fleece was found.
