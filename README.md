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

**Forms.** The Avatar's Form select offers the dress forms in `assets/forms.json`: f-M and
f-M with head (`tools/dressform.py --head`). The file also carries each form's landmarks (body
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
- **Internal** (G) draws an internal line on the selected piece (Enter or a double click ends
  it); **Int □**, **Int ○** and **Int ⬠** draw an internal rectangle, ellipse or polygon.
- **Hole □**, **Hole ○** and **Hole ⬠** cut a rectangular, elliptical or polygonal hole in a
  piece; **To hole** turns an internal closed shape into a hole.
- **Cut** splits a piece along an internal line, or along a cutter drawn across the selected
  piece (Enter ends it): two pieces with the same fabric, grain, allowance and layer; seams,
  notches and internal shapes go with the half they lie on (a seam split by the cut is dropped,
  and the status names it). **Cut & sew** also sews the two new edges.
- **Trace** copies an internal closed shape out as a new piece.
- **Fillet** rounds a corner: click it, then drag or type the radius.
- **Edit** (Z) and **Move** (A) as before; **Sew sides** (N), **Sew free** (M).

**Slots**: Front, Back, the sides and arms; Hood left / Hood right beside the head of a form
that has one; **On <piece>** puts a piece on another (its frame and wrap, 8 mm out a layer).
**Arrange** puts pieces sewn to placed pieces on them, then fills the free slots.

## Live drape

**Simulate** in the 3D strip meshes the garment and runs the kernel's cloth solver on it: the
shirt sews with gravity off until every seam is closed (or 60 frames), then drapes onto the
avatar. **Pause** stops it, **Reset** drops the cloth and brings the flat pieces back.

- **Engine**: on a WebGPU browser the cloth steps on the View's GPU (`gpu-drape.js`, in the View's
  worker), at about 28 frames a second for the sample T-shirt in Chrome on an RTX 3070 (2 on the
  CPU worker; `ATELIER_FPS=1 node test/browser.mjs` measures it). Elsewhere (WebGL2), or
  with `?cloth=cpu` in the URL, it steps on the CPU in a worker of its own (`cloth-worker.js`).
  The 3D strip says which: `GPU · GIA off` or `CPU`.

- **Pin**: click the cloth to pin the nearest point where it is; click it again to unpin.
- **Drag**: press on the cloth and pull; the point follows the pointer on the plane facing the
  camera. Right or middle drag and the wheel still move the camera while a tool is on.
- **Editing while it runs**: a 2D edit of an outline, a grain or a seam's range re-meshes that
  piece and keeps the drape (also live, during a 2D drag). A 2D move of a piece changes nothing
  in 3D. Adding or removing a piece, seam or fabric, a fabric's values or a new avatar make the
  cloth stale: the strip says so, and Simulate (paused) rebuilds it.
- **Health**: the strip shows the frame, the phase, the welded seam pairs, the mesh size and the
  fastest particle; the footer the simulated frames per second and the time a step takes. A
  particle going non-finite or faster than 50 m/s, or a step taking over 5 s, pauses the cloth.
- `node tools/drape-probe.mjs [garment.json] [frames] [every]` steps a garment's cloth in Node
  and prints its health: a quick look at whether it sews and drapes, without the page.

## Limitations (preview)

- On the CPU the drape runs at 2-5 frames a second; the View draws at the display rate
  meanwhile and the cloth moves as frames arrive.
- On the GPU the cloth is one View item in one colour (the first piece's fabric): its pieces
  are not coloured apart and the selection accent does not show on it.
- On the GPU the global intersection analysis (GIA) is off until it is ported; the CPU path
  keeps it on.
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
- Slot frames go stale: after a 2D move or edit, or a new avatar, a placed piece drifts off its slot.
- Avatars are STEP only. STL dress forms wait for the kernel's STL reader.
- Forms with a head: only f-M so far.
- Fabric presets come from published KES-F measurements: the sources and the conversion are in
  [docs/fabric-sources.md](docs/fabric-sources.md). Many sources publish one value for both
  directions, so warp and weft (and the biases) often carry the same number.
