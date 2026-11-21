# Fabric preset sources

The presets in `fabrics.js` are published KES-F (Kawabata) measurements converted to the kernel's
units by our own formula. No CLO3D library or material file was used. Nothing is estimated: a value
the source did not publish is `null` in `PRESETS` and takes one of our documented defaults (below).

KES-F units: EMT % strain at 500 gf/cm; G gf/(cm·deg); B gf·cm²/cm; W mg/cm² (= g/m² / 10);
T mm at 0.5 gf/cm²; MIU dimensionless. Where a paper printed cN-based units (cN·cm²/cm,
cN/(cm·deg)) the value was multiplied by 1.019716 (1 cN = 1.019716 gf).

## Presets

Values are EMT warp/weft, G, B warp/weft, W, T, MIU as stored in `PRESETS` (after cN conversion).

| slug | EMT warp / weft (%) | G | B warp / weft | W | T (mm) | MIU | Citation |
|---|---|---|---|---|---|---|---|
| cotton_poplin | 9.14 / 9.14 | 2.81 | 0.103 / 0.103 | 17.5 | 0.975 | 0.20 | Kan, C.-W. and Lam, Y.-L., "Low Stress Mechanical Properties of Plasma-Treated Cotton Fabric Subjected to Zinc Oxide-Anti-Microbial Treatment", Materials 6(1), 314-333, 2013, Table 4 (control row; fabric spec in Sec. 2.1). DOI 10.3390/ma6010314, https://pmc.ncbi.nlm.nih.gov/articles/PMC5452122/ |
| wool_suiting | 3.02 / 9.58 | 0.744 | 0.0330 / 0.0164 | 16.18 | 0.439 | null | Petrak, S., Mahnic Naglic, M., Rogale, D., Gersak, J., "Analysis of Polygonal Computer Model Parameters and Influence on Fabric Drape Simulation", Materials 14(21), 6259, 2021, Tables 1-2, fabric F4. https://pmc.ncbi.nlm.nih.gov/articles/PMC8584912/ |
| polyester_plain | 3.90 / 31.28 | 0.469 | 0.00867 / 0.00337 | 8.37 | 0.356 | null | Petrak et al. 2021 (as above), Tables 1-2, fabric F2 |
| cotton_jersey | 9.365 / 9.365 | 0.79 | 0.027 / 0.027 | 16.2 | null | 0.208 | Narasimhan, S. K. A., Kanakaraj, P., Rajagopalan, R., "Virtual Fit Evaluation for Optimization of Garment Component's Parameters", Tekstil ve Muhendis 31(136), 269-276, 2024, Tables 1-2 (p. 271), fabric F1. DOI 10.7216/teksmuh.1500589, https://dergipark.org.tr/tr/download/article-file/4002942 |
| cotton_lycra_jersey | 17.07 / 17.07 | 0.58 | 0.010 / 0.010 | 14.5 | null | 0.223 | Narasimhan et al. 2024 (as above), Tables 1-2, fabric F2 |
| silk_twill | 11.29 / 11.29 | 0.369 | 0.0428 / 0.0428 | 18.0 | null | null | Singh, M. K., "A Study on Comparative Hand Behaviour of Fabrics Produced from Different Natural and Man-made Fibers", J. Fashion Technology & Textile Engineering 9(4), 1000202, 2021, Tables 1, 2 and 5, fabric F2. https://www.scitechnol.com/peer-review-pdfs/a-study-on-comparative-hand-behaviour-of-fabrics-produced-from-different-natural-and-manmade-fibers-Vqy6.pdf |
| denim | 5.515 / 5.515 | 2.18 | 0.172 / 0.172 | 24.6 | 1.066 | null | Kumari, A. and Khurana, K., "Regenerated Cellulose-Based Denim Fabric for Tropical Regions: An Analytical Study on Making Denim Comfortable", J. Textiles 2016, Article ID 4614168, Tables 2 and 5, sample A. DOI 10.1155/2016/4614168, https://repository.uantwerpen.be/docstore/d:irua:20324 |
| polyester_lycra_woven | 1.84 / 79.20 | 0.77 | 0.0665 / 0.0134 | 10.539 | null | 0.300 | Varghese, N. and Thilagavathi, G., "Handle and Comfort Characteristics of Cotton Core Spun Lycra and Polyester/Lycra Fabrics for Application as Blouse", JTATM 8(4), Spring 2014, Tables 1-5, fabric T5. https://jtatm.textiles.ncsu.edu/index.php/JTATM/article/download/5341/2853 |

## Caveats per fabric

- **cotton_poplin**: semi-bleached plain weave, 58 ends/cm x 58 picks/cm, 175 g/m². The paper does not call it poplin; it is the closest published dense balanced shirting weave. EMT and B are one averaged value in the paper, duplicated into warp and weft. W derived from 175 g/m². T 0.975 mm looks thick for the weight but is as published.
- **wool_suiting**: 100% wool plain 1/1, 161.8 g/m². The paper does not say worsted. The paper's "EM" is extension at 490.35 cN, taken as EMT. B (printed 0.0324 / 0.0161) and G (printed 0.73) were cN-based and are converted x1.019716. W derived from the mass in Table 1. MIU not published.
- **polyester_plain**: 100% polyester plain 1/1, 83.7 g/m². Not stated to be taffeta, so it is not labelled taffeta. Weft EMT 31.28 % is unusually high but as published. B (printed 0.0085 / 0.0033) and G (printed 0.46) converted x1.019716. W derived from mass. MIU not published.
- **cotton_jersey**: 100% cotton single jersey, 162 g/m². Not split into wale/course, so EMT and B are duplicated into both slots (a real jersey stretches more coursewise). W derived from GSM. T: Table 1 prints 0.61 mm without stating the method, so T is null.
- **cotton_lycra_jersey**: 95% cotton / 5% Lycra single jersey, 145 g/m². Same paper and caveats as cotton_jersey (not directional, W from GSM, T null). It stands in for a stretch knit; the fibre is cotton, not polyester.
- **silk_twill**: 100% mulberry silk 2/1 twill, 180 g/m². Not charmeuse or satin. The paper's "low stress extensibility" is taken as EMT (the max load is not printed). B (printed 0.042) and G (printed 0.362) converted x1.019716. Not directional; W derived from GSM; T and MIU not published. Lower-tier venue; the paper's Table 2 unit column is misaligned, so Table 5's units were used.
- **denim**: 100% cotton indigo denim, 246 g/m². Not directional. The paper's Table 5 W row (104 mg/cm²) contradicts its own GSM, so W is derived from the 246 g/m² of Table 2. The printed MIU (1.765) is 6-10x the normal range and is not used (null).
- **polyester_lycra_woven**: a woven, not a knit: polyester warp, polyester/Lycra weft, 1x1 plain, 105.39 g/m². G is the printed warp/weft average (0.92 / 0.62 -> 0.77) and MIU the printed average (0.301 / 0.299 -> 0.300). W derived from GSM. T: Table 1 prints 0.71 mm, method not stated, so T is null.

Not shipped: linen, taffeta, silk charmeuse/satin and a polyester/elastane knit have no open source with EMT, B and W found; they are dropped rather than guessed.

## Estimated presets (not measured)

- **cotton_fleece** ("Cotton fleece (estimated)", `estimated: true`): no citable KES-F values for a cotton fleece or French terry were found, so this is cotton_jersey (Narasimhan 2024 F1) scaled to a typical 300 g/m², 1.5 mm fleece, with w = 30/16.2 = 1.852 and t = 1.5/0.61 = 2.459 (0.61 mm is the jersey's printed T). B x w·t = 4.554 (0.123): the geometric mean of more-yarn scaling (x w) and solid-plate scaling (x w·t² = 11.2, which would make it stiffer than denim), since the raised loop pile adds thickness but little bending stiffness. G x w (1.463): shear resistance grows with yarn per area. EMT x w^-1/2 = 0.735 (6.882 %): between unchanged loop geometry (x1) and pure yarn-count scaling (x 1/w), since knit extension is loop opening, which the tucked backing yarn restricts. W 30, T 1.5 set; MIU 0.208 kept. The app shows it as an estimate (label, library tooltip, Source row in the fabric panel).

## Conversion (`fromKes`)

g = 9.80665 m/s²; 1 gf/cm = 0.980665 N/m = 980.665 g/s².

- `stretch_{warp,weft}` = (500 / (EMT/100)) x 980.665 g/s²: secant tensile stiffness at the KES limit load.
- `shear_{left,right}` = G x (180/π) x 980.665 g/s² per radian. Left and right are equal: KES does not split bias shear.
- `bending_{warp,weft}` = B x 9.80665e4 g·mm²/s² (1 gf·cm²/cm = 9.80665e-5 N·m, and 1 N·m = 1e9 g·mm²/s²).
- `bending_bias_{left,right}` = mean of warp and weft bending.
- `density` = W x 1e-5 g/mm² (1 mg/cm² = 1e-3 g / 100 mm²).
- `thickness` = T mm; `friction` = MIU.

## Our defaults (not measured, not from any source)

- `buckling_ratio_*` = 0.5 and `buckling_stiffness_*` = 0.5. KES has no buckling measure. Both are unitless: the kernel bends a buckled hinge with bending x `buckling_stiffness` (CLO's meaning). The app once stored 0.5 x the bending here (g·mm²/s²), which made buckled hinges ~1000-6000 times stiffer and the cloth jitter for ever; a fabric with a value above 1 is converted to value / bending (clamped to 1) when a document is opened.
- `internal_damping` = 0.1. KES has no damping measure.
- Where a source did not publish a value (null in `PRESETS`), `fromKes` uses: T = 0.5 mm, MIU = 0.2, G = 0.8 gf/(cm·deg).
