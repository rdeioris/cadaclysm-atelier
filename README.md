# Cadaclysm Atelier

Atelier is a garment-design web app built on the cadaclysm kernel's web package: you draw flat
pattern pieces, join them with seams, and see the garment, in plain ES modules with no bundler.

    npm install
    npm run setup -- --pkg <folder>     # or: npm run setup -- --zip <package.zip>
    npm start                           # http://localhost:8141/
    npm test
    npm run test:browser                # the page end to end in headless Chrome or Edge

**Sample: T-shirt** in the menu opens `assets/tshirt.json`: front, back and two sleeves in
cotton jersey, sewn and placed around the f-M dress form (a women's M: chest 920 mm, body
length 650 mm, sleeve length 200 mm). `node tools/make-sample.mjs` writes it through the
kernel and checks that every seam's two sides match within 2 %. Its front and back stand
about 50 mm clear of the form and its sleeves are wrapped round the form's arms, so the cloth
sews it shut before it drapes.

## Live drape

**Simulate** in the 3D strip meshes the garment and runs the kernel's cloth solver on it in a
worker of its own (`cloth-worker.js`): the shirt sews with gravity off until every seam is
closed (or 60 frames), then drapes onto the avatar. **Pause** stops it, **Reset** drops the
cloth and brings the flat pieces back.

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

- The drape runs at 2-5 frames a second: the solver's performance pass (milestone 5) is under
  way. The View draws at the display rate meanwhile; the cloth moves as frames arrive.
- A settled shirt still has a few particles jittering at 2-10 m/s (the health line's max speed).
- Before Simulate the 3D window draws each piece flat at its frame: a sleeve wrapped round an
  arm shows as a flat slab along the arm until the cloth is built.
- Arrange's arm slots stand the sleeves flat beside the arms, as before. Sleeves there sew too
  slowly: the shirt starts to drape before they close. The sample wraps its sleeves instead.
- DXF import brings in outlines, allowances, grain lines and notches. Internal lines are
  dropped (the kernel has no getter for them yet), and so are the 3D slots: imported pieces lie
  on the floor until arranged.
- The sample's sleeve caps have zero ease: each cap half is exactly as long as its armhole.
- Slot frames go stale: after a 2D move or edit, or a new avatar, a placed piece drifts off its slot.
- Avatars are STEP only. STL dress forms wait for the kernel's STL reader.
- Fabric presets come from published KES-F measurements: the sources and the conversion are in
  [docs/fabric-sources.md](docs/fabric-sources.md). Many sources publish one value for both
  directions, so warp and weft (and the biases) often carry the same number.
