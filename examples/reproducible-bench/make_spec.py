#!/usr/bin/env python3
"""
make_spec.py — package the distilled figure tables into ONE dashboard spec.

This is the hand-off boundary of the reproducible bench, re-targeted at
canvasxpress-dashboards: everything upstream (the distillation) decided WHAT
to show and wrote figures/*.csv; this step wires those reduced tables plus
recipe.json into a single bench.spec.json. No statistics happen here — the
clustering, the Kaplan-Meier math, and the layout are all computed by
CanvasXpress in the browser when the dashboard renders.

Data flow:
    (upstream R/Python distillation, out of scope here)
        └─▶ figures/heatmap.csv, oncoprint.csv, survival.csv, clinical.csv
                └─▶ make_spec.py  (+ recipe.json: palette, methods, titles)
                        └─▶ bench.spec.json
                                └─▶ renderDashboard() / builder / server

Run:  python3 make_spec.py          (stdlib only)
"""
import csv, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
recipe = json.load(open(os.path.join(HERE, "recipe.json")))
pal = recipe["palette"]


def rd(rel):
    return os.path.join(HERE, rel)


def read_matrix(path, numeric):
    with open(path) as f:
        r = csv.reader(f)
        smps = next(r)[1:]
        vars, data = [], []
        for row in r:
            vars.append(row[0])
            data.append([float(x) for x in row[1:]] if numeric else row[1:])
    return smps, vars, data


# clinical -> per-sample overlay block, joined by sample key so order follows the matrix
clin = {row["sample"]: row for row in csv.DictReader(open(rd("figures/clinical.csv")))}


def overlays(smps, keys):
    return {k: [clin[s][k] for s in smps] for k in keys}


# ---------------- data sources (one per distilled table) ----------------
smps, genes, heat = read_matrix(rd("figures/heatmap.csv"), numeric=True)
expression = {"y": {"vars": genes, "smps": smps, "data": heat},
              "x": overlays(smps, ["cluster", "subtype", "stage", "age"])}

# Oncoprint = layered Heatmap, transposed: vars = samples, smps = genes.
# The numeric `data` layer is an alteration indicator; `data2` carries CNA
# levels and `data3` mutation levels (CanvasXpress's standard color mapping
# recognizes these level names).
osmps, ogenes, ocells = read_matrix(rd("figures/oncoprint.csv"), numeric=False)
CNA = {"AMP": "Amplification", "DEL": "Deep Deletion"}
MUT = {"MUT": "Missense", "FUS": "Fusion"}
onco_data, onco_cna, onco_mut = [], [], []
for j, s in enumerate(osmps):
    cells = [ocells[g][j] for g in range(len(ogenes))]
    onco_data.append([1 if c else 0 for c in cells])
    onco_cna.append([CNA.get(c, "") for c in cells])
    onco_mut.append([MUT.get(c, "") for c in cells])
variants = {"y": {"vars": osmps, "smps": ogenes,
                  "data": onco_data, "data2": onco_cna, "data3": onco_mut},
            "z": overlays(osmps, ["cluster", "subtype", "stage"])}

# Kaplan-Meier: vars = samples (rows), smps = [time, event], group in z.
surv = list(csv.DictReader(open(rd("figures/survival.csv"))))
survival = {"y": {"vars": [d["sample"] for d in surv],
                  "smps": ["time", "event"],
                  "data": [[float(d["time_months"]), int(d["event"])] for d in surv]},
            "z": {"group": [d["group"] for d in surv]}}

# consistency assertions — the whole chain must agree
assert smps == osmps, "heatmap and oncoprint sample order differ"
assert len(surv) == len(smps), "survival rows != sample count"

# ---------------- the dashboard spec ----------------
spec = {
    "id": "reproducible-bench",
    "title": "The Reproducible Bench",
    "version": 1,
    "broadcastGroup": "reproducible-bench",
    "theme": "auto",
    "layout": {
        "cols": 12,
        "rowHeight": 130,
        "gap": 12,
        "items": [
            {"panel": "heatmap",   "x": 0, "y": 0, "w": 7, "h": 4},
            {"panel": "survival",  "x": 7, "y": 0, "w": 5, "h": 4},
            {"panel": "oncoprint", "x": 0, "y": 4, "w": 12, "h": 3},
        ],
    },
    "data": {
        "expression": {"kind": "inline", "value": expression},
        "variants":   {"kind": "inline", "value": variants},
        "survival":   {"kind": "inline", "value": survival},
    },
    "panels": {
        "heatmap": {
            "title": "Expression — top %d variable genes" % len(genes),
            "dataRef": "expression",
            "config": {
                "graphType": "Heatmap", "title": False,
                "samplesClustered": True, "variablesClustered": True,
                "smpOverlays": ["cluster", "subtype", "stage"],
                "colorSpectrum": pal["spectrum"],
            },
        },
        "oncoprint": {
            "title": "Oncoprint — top %d recurrently altered genes" % len(ogenes),
            "dataRef": "variants",
            "config": {
                "graphType": "Heatmap", "title": False,
                "oncoprintCNA": "data2", "oncoprintMUT": "data3",
                "varOverlays": ["cluster", "subtype", "stage"],
            },
        },
        "survival": {
            "title": "Overall survival by transcriptional cluster",
            "dataRef": "survival",
            "config": {
                "graphType": "KaplanMeier", "title": False,
                "xAxis": ["time"], "yAxis": ["event"],
                "colorBy": "group", "colors": pal["groups"],
                "showKMConfidenceIntervals": True,
                "xAxisTitle": "Months", "yAxisTitle": "Survival probability",
            },
        },
    },
    "controls": [
        {"kind": "table", "dataRef": "survival", "title": "Cohort (distilled clinical + derived cluster)"},
    ],
}

out = rd("bench.spec.json")
with open(out, "w") as f:
    json.dump(spec, f, indent=2)
print("wrote %s  (%d samples, %d heatmap genes, %d oncoprint genes)"
      % (os.path.relpath(out, HERE), len(smps), len(genes), len(ogenes)))
