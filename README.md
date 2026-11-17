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
kernel and checks that every seam's two sides match within 2 %.

## Limitations (preview)

- No simulation yet: the pieces stand flat around the form, and Simulate waits for the solver
  (milestone 4b).
- DXF import brings in outlines, allowances, grain lines and notches. Internal lines are
  dropped (the kernel has no getter for them yet), and so are the 3D slots: imported pieces lie
  on the floor until arranged.
- The sample's sleeve caps have zero ease: each cap half is exactly as long as its armhole.
- Avatars are STEP only. STL dress forms wait for the kernel's STL reader.
- Fabric presets come from published KES-F measurements: the sources and the conversion are in
  [docs/fabric-sources.md](docs/fabric-sources.md). Many sources publish one value for both
  directions, so warp and weft (and the biases) often carry the same number.
