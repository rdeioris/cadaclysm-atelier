"""The golden fixture the JS port of tools/dressform.py is checked against
(test/form-grade.test.mjs): every chart size's grading and landmarks, from the script itself.
Reads dressform.py, never changes it; builds no geometry (importing loads no DLL).

    CADACLYSM_BS_PY=<folder holding cadaclysm_blacksmith.py> python tools/dressform-golden.py test/fixtures/dressform-golden.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dressform as df  # noqa: E402

COMMAND = "CADACLYSM_BS_PY=<kernel>/crates/cadaclysm-blacksmith-capi/examples python tools/dressform-golden.py test/fixtures/dressform-golden.json"


def main():
    out = {"generator": COMMAND, "forms": []}
    for body in ("female", "male"):
        for size in df.SIZES:
            gr = df.Grade(body, size)
            name = f"{body[0]}-{size}"
            out["forms"].append({
                "body": body, "size": size, "f": gr.f, "h": gr.h, "belly": gr.belly,
                "sections": [list(s) for s in gr.sections], "girths": gr.girths(),
                "landmarks": df.landmarks(gr, name, name, False),
                "landmarks_head": df.landmarks(gr, name + "-head", name + "-head", True),
            })
    with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(f"{sys.argv[1]}: {len(out['forms'])} forms")


if __name__ == "__main__":
    main()
