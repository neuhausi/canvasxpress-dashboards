"""Live data services for the five database dashboards.

One place that turns a SQLite database (CCLE / TCGA / GTEx / GENCODE /
WikiPathways) into the CanvasXpress `.data` payloads each dashboard's panels
consume. Imported by BOTH the standalone ``db-adapter.py`` and the demo
``serve.py`` so the two never drift.

Databases are looked up in ``CXD_SQLITE_DIR`` (default ``~/Downloads/sqlite``)
as ``<db>.sqlite``; per-db overrides via ``CCLE_SQLITE`` etc.
"""
import os
import json
import math
import sqlite3

SQLITE_DIR = os.path.expanduser(os.environ.get("CXD_SQLITE_DIR", "~/Downloads/sqlite"))
LABEL = {"cnv": "log2(CN ratio + 1)", "rna": "log2(tpm + 0.001)"}


def db_path(db):
    override = os.environ.get(db.upper() + "_SQLITE")
    return os.path.expanduser(override) if override else os.path.join(SQLITE_DIR, db + ".sqlite")


def _cur(db):
    con = sqlite3.connect("file:%s?mode=ro" % db_path(db), uri=True)
    return con.cursor()


def _ds1(var, smps, data, ann, ann_vals):
    return {"y": {"vars": [var], "smps": list(smps), "data": [list(data)]},
            "x": {ann: list(ann_vals)}}


def _dsN(vars_, smps, rows, ann, ann_vals):
    return {"y": {"vars": list(vars_), "smps": list(smps), "data": [list(r) for r in rows]},
            "x": {ann: list(ann_vals)}}


# ===================================================================== CCLE
def _jkey(c, k):
    r = c.execute("SELECT str FROM json WHERE key=?", (k,)).fetchone()
    return json.loads(r[0]) if r else None


def _ikey(c, k):
    return json.loads(c.execute("SELECT str FROM indices WHERE key=?", (k,)).fetchone()[0])


def _blob(c, table, col, gene):
    r = c.execute("SELECT %s FROM %s WHERE name=?" % (col, table), (gene,)).fetchone()
    return json.loads(r[0]) if r else None


def _ccle_genes(c):
    names = [r[0] for r in c.execute("SELECT DISTINCT name FROM rnaseq ORDER BY name")]
    return {"y": {"vars": ["n"], "smps": names, "data": [[1] * len(names)]}, "x": {"gene": names}}


def _ccle_distribution(c, gene, dtype):
    base = _jkey(c, "cnv1" if dtype == "cnv" else "rna1")
    vals = _blob(c, "cnv", "cnratio", gene) if dtype == "cnv" else _blob(c, "rnaseq", "log2tpm", gene)
    if base is None or vals is None:
        return None
    base["data"]["y"]["vars"].append(gene)
    base["data"]["y"]["data"].append(vals)
    return base["data"]


def _ccle_heatmap(c, genes, dtype):
    base = _jkey(c, "cnv1" if dtype == "cnv" else "rna1")
    tbl, col = ("cnv", "cnratio") if dtype == "cnv" else ("rnaseq", "log2tpm")
    hit = False
    for g in genes:
        vals = _blob(c, tbl, col, g)
        if vals is None:
            continue
        base["data"]["y"]["vars"].append(g)
        base["data"]["y"]["data"].append(vals)
        hit = True
    return base["data"] if hit else None


def _ccle_correlation(c, genex, typex, geney, typey):
    tx = "cnv" if typex == "cnv" else "rna"
    ty = "cnv" if typey == "cnv" else "rna"
    px = _blob(c, "cnv", "cnratio", genex) if tx == "cnv" else _blob(c, "rnaseq", "log2tpm", genex)
    py = _blob(c, "cnv", "cnratio", geney) if ty == "cnv" else _blob(c, "rnaseq", "log2tpm", geney)
    if px is None or py is None:
        return None
    if tx == ty:
        pj = _jkey(c, "cnv2" if tx == "cnv" else "rna2")
        data = [[px[i], py[i]] for i in range(len(px))]
    elif tx == "cnv" and ty == "rna":
        pj = _jkey(c, "cnv-rna2"); pi = _ikey(c, "cnv-rna")
        data = [[px[pi[0][i]], py[pi[1][i]]] for i in range(len(pi[0]))]
    else:
        pj = _jkey(c, "cnv-rna2"); pi = _ikey(c, "cnv-rna")
        data = [[px[pi[1][i]], py[pi[0][i]]] for i in range(len(pi[0]))]
    pj["data"]["y"]["smps"] = [genex + " " + LABEL[tx], geney + " " + LABEL[ty]]
    pj["data"]["y"]["data"] = data
    return pj["data"]


def _ccle_mutations(c, gene):
    ms = c.execute("SELECT sample,chrom,start,\"end\",reference,alt,gene,transcript,effect,"
                   "genome_change,prot_change FROM mutation WHERE gene=?", (gene,)).fetchall()
    g = c.execute("SELECT name,chrom,start,\"end\",strand FROM gene WHERE name=?", (gene,)).fetchone()
    if not ms or not g:
        return None
    y, t = {}, {}
    for m in ms:
        off = m[2]
        y[off] = y.get(off, 0) + 1
        eff = m[8] or "Other"           # colour by mutation effect (clean categories)
        t.setdefault(off, {})
        t[off][eff] = t[off].get(eff, 0) + 1
    dframe = {"name": "Mutations", "type": "dataframe",
              "dataframe": {"offset": [], "number": [], "type": []}, "height": 400,
              "data": [{"id": "Data-Frame", "data": [{"xAxis": "offset", "yAxis": "number",
                        "setMinY": 0, "type": "lollipop", "side": "left",
                        "colorBy": "type", "hideLegend": True}]}]}
    for off in sorted(y):
        dframe["dataframe"]["offset"].append(off)
        dframe["dataframe"]["number"].append(y[off])
        # dominant category at this position (single clean value, not a comma-join)
        dframe["dataframe"]["type"].append(max(t[off].items(), key=lambda kv: kv[1])[0])
    name, chrom, start, end, strand = g
    box = {"name": "Genes", "type": "box", "connect": "true",
           "data": [{"id": name, "fill": "rgb(0,0,255)", "outline": "rgb(0,0,255)",
                     "dir": "right" if strand == "+" else "left",
                     "start": start, "end": end, "chrom": chrom, "data": [[start, end]]}],
           "chrom": chrom, "max": end, "min": start}
    return {"tracks": [dframe, box]}


def _ccle(qs):
    c = _cur("ccle")
    g = lambda k: qs.get(k, [None])[0] if isinstance(qs.get(k), list) else qs.get(k)
    if g("list") == "genes":
        return _ccle_genes(c)
    if g("correlation"):
        return _ccle_correlation(c, g("genex"), g("typex"), g("geney"), g("typey"))
    if g("mutations"):
        return _ccle_mutations(c, g("search"))
    if g("type") == "heatmap":
        return _ccle_heatmap(c, [s.strip() for s in (g("search") or "").split(",") if s.strip()],
                             g("data") or "rnaseq")
    if g("type") == "violin":
        return _ccle_distribution(c, g("search"), g("data") or "rnaseq")
    return None


# ============================================================ aggregate DBs
def _tcga(source):
    c = _cur("tcga")
    rows = c.execute(
        "SELECT cancer_type_abbreviation c, COUNT(*) n, SUM(vital_status='Alive'), "
        "SUM(vital_status='Dead'), ROUND(AVG(age_at_initial_pathologic_diagnosis),1) "
        "FROM sample WHERE cancer_type_abbreviation!='' GROUP BY c ORDER BY n DESC LIMIT 16").fetchall()
    canc = [r[0] for r in rows]
    if source == "samples":
        return _ds1("Samples", canc, [r[1] for r in rows], "Cancer", canc)
    if source == "outcome":
        return _dsN(["Alive", "Deceased"], canc, [[r[2] for r in rows], [r[3] for r in rows]], "Cancer", canc)
    if source == "age":
        return _ds1("Mean age", canc, [r[4] for r in rows], "Cancer", canc)
    return None


def _gtex(source):
    c = _cur("gtex")
    rows = c.execute("SELECT tissue, COUNT(*) n, SUM(sex='female'), SUM(sex='male') "
                     "FROM samples GROUP BY tissue ORDER BY n DESC LIMIT 16").fetchall()
    tis = [r[0] for r in rows]
    if source == "tissues":
        return _ds1("Samples", tis, [r[1] for r in rows], "Tissue", tis)
    if source == "sex":
        return _dsN(["Women", "Men"], tis, [[r[2] for r in rows], [r[3] for r in rows]], "Tissue", tis)
    return None


_CHROM_ORDER = ["chr01", "chr02", "chr03", "chr04", "chr05", "chr06", "chr07", "chr08",
                "chr09", "chr10", "chr11", "chr12", "chr13", "chr14", "chr15", "chr16",
                "chr17", "chr18", "chr19", "chr20", "chr21", "chr22", "chrX", "chrY"]


def _pad_chrom(raw):
    if raw in ("chrX", "chrY"):
        return raw
    n = raw.replace("chr", "")
    return "chr%02d" % int(n) if n.isdigit() else None


def _gencode(source):
    c = _cur("gencode")
    if source in ("proteinCoding", "lncRNA"):
        biotype = "protein_coding" if source == "proteinCoding" else "lncRNA"
        rows = c.execute("SELECT chrom, COUNT(DISTINCT geneId) FROM genome WHERE geneType=? GROUP BY chrom",
                         (biotype,)).fetchall()
        by = {}
        for raw, n in rows:
            p = _pad_chrom(raw)
            if p:
                by[p] = n
        vals = [by.get(ch, 0) for ch in _CHROM_ORDER]
        var = "Protein-coding" if source == "proteinCoding" else "lncRNA"
        return _ds1(var, _CHROM_ORDER, vals, "Chromosome", _CHROM_ORDER)
    if source == "biotypes":
        rows = c.execute("SELECT geneType, COUNT(DISTINCT geneId) n FROM genome "
                         "GROUP BY geneType ORDER BY n DESC LIMIT 9").fetchall()
        bts = [r[0] for r in rows]
        return _ds1("Genes", bts, [r[1] for r in rows], "Biotype", bts)
    return None


def _wp(source):
    c = _cur("wp")
    if source in ("pathways", "memberships"):
        orgs = [r[0] for r in c.execute(
            "SELECT taxName FROM pathway GROUP BY taxName ORDER BY COUNT(*) DESC LIMIT 12")]
        if source == "pathways":
            counts = {r[0]: r[1] for r in c.execute("SELECT taxName, COUNT(*) FROM pathway GROUP BY taxName")}
            return _ds1("Pathways", orgs, [counts.get(o, 0) for o in orgs], "Organism", orgs)
        mem = {r[0]: r[1] for r in c.execute(
            "SELECT p.taxName, COUNT(*) FROM pathway p JOIN members m ON p.wpId=m.wpId GROUP BY p.taxName")}
        return _ds1("Gene memberships", orgs, [mem.get(o, 0) for o in orgs], "Organism", orgs)
    if source == "topHuman":
        rows = c.execute("SELECT p.name, COUNT(m.geneId) n FROM pathway p JOIN members m ON p.wpId=m.wpId "
                         "WHERE p.taxName='Homo sapiens' GROUP BY p.wpId ORDER BY n DESC LIMIT 12").fetchall()
        names = [r[0] for r in rows]
        return _ds1("Genes", names, [r[1] for r in rows], "Pathway", names)
    return None


_AGG = {"tcga": _tcga, "gtex": _gtex, "gencode": _gencode, "wp": _wp}


# ============================================ interactive explorers (per DB)
# Each mirrors the CCLE explorer's shape: an entity list (for autocomplete) plus
# one or more per-entity live panels. Reached via explorer query params; the
# aggregate `source=` views on the same endpoint are left untouched.
def _get(qs):
    def g(k):
        v = qs.get(k)
        return v[0] if isinstance(v, list) else v
    return g


def _entity_list(names, ann):
    return {"y": {"vars": ["n"], "smps": names, "data": [[1] * len(names)]}, "x": {ann: names}}


def _tcga_explore(qs):
    c = _cur("tcga"); g = _get(qs)
    if g("list") == "genes":
        return _entity_list([r[0] for r in c.execute("SELECT DISTINCT name FROM rnaseq ORDER BY name")], "gene")
    gene = g("search")
    if g("type") == "violin" and gene:
        base = _jkey(c, "rna1min")
        vals = _blob(c, "rnaseq", "log2tpm", gene)
        if base is None or vals is None:
            return None
        base["data"]["y"]["vars"].append(gene)
        base["data"]["y"]["data"].append(vals)
        return base["data"]
    if g("mutations") and gene:
        ms = c.execute("SELECT sample,chrom,start,\"end\",reference,alt,gene,effect,aa_change "
                       "FROM mutation WHERE gene=?", (gene,)).fetchall()
        gr = c.execute("SELECT name,chrom,start,\"end\",strand,exonStarts,exonEnds "
                       "FROM gene WHERE name=?", (gene,)).fetchone()
        if not ms or not gr:
            return None
        y, t = {}, {}
        for m in ms:
            off = m[2]
            y[off] = y.get(off, 0) + 1
            eff = m[7] or "Other"                        # colour by mutation effect
            t.setdefault(off, {})
            t[off][eff] = t[off].get(eff, 0) + 1
        dframe = {"name": "Mutations", "type": "dataframe",
                  "dataframe": {"offset": [], "number": [], "type": []}, "height": 400,
                  "data": [{"id": "Data-Frame", "data": [{"xAxis": "offset", "yAxis": "number",
                            "setMinY": 0, "type": "lollipop", "side": "left",
                            "colorBy": "type", "hideLegend": True}]}]}
        for off in sorted(y):
            dframe["dataframe"]["offset"].append(off)
            dframe["dataframe"]["number"].append(y[off])
            # dominant effect at this position (single clean value, not a comma-join)
            dframe["dataframe"]["type"].append(max(t[off].items(), key=lambda kv: kv[1])[0])
        name, chrom, start, end, strand, ex_s, ex_e = gr
        # Draw the exon model (one segment per exon) when exon coords exist,
        # else fall back to a single whole-gene segment.
        estarts = [int(x) for x in str(ex_s).split(",") if x != ""]
        eends = [int(x) for x in str(ex_e).split(",") if x != ""]
        segments = ([[estarts[i], eends[i]] for i in range(min(len(estarts), len(eends)))]
                    if estarts and eends else [[start, end]])
        box = {"name": "Genes", "type": "box", "connect": "true",
               "data": [{"id": name, "fill": "rgb(0,0,255)", "outline": "rgb(0,0,255)",
                         "dir": "right" if strand == "+" else "left",
                         "start": start, "end": end, "chrom": chrom, "data": segments}],
               "chrom": chrom, "max": end, "min": start}
        return {"tracks": [dframe, box]}
    return None


def _gtex_base(c):
    return json.loads(c.execute("SELECT samples FROM json").fetchone()[0])


def _gtex_explore(qs):
    c = _cur("gtex"); g = _get(qs)
    if g("list") == "genes":
        return _entity_list([r[0] for r in c.execute("SELECT DISTINCT geneName FROM expression ORDER BY geneName")], "gene")
    gene = g("search")
    if g("type") == "violin" and gene:
        row = c.execute("SELECT tpm FROM expression WHERE geneName=?", (gene,)).fetchone()
        if not row:
            return None
        base = _gtex_base(c)
        vals = [float(x) for x in row[0].split(";")]
        base["data"]["y"]["vars"] = [gene]
        base["data"]["y"]["data"] = [vals]
        return base["data"]
    return None


_GENCODE_COLS = ("SELECT geneName,geneId,transcriptId,geneType,chrom,strand,exonStarts,exonEnds "
                 "FROM genome ")


def _gencode_explore(qs):
    """Genome browser, reproducing gencodeServices.pl: search a gene -> a Genome
    graph with a Genes track (each transcript's exon model) plus a GWAS Catalog
    track (SNPs in the window). Panning/zooming re-queries with chrom+start+window
    (the `chromStart` path), so the browser navigates live."""
    c = _cur("gencode"); g = _get(qs)
    if g("list") == "genes":
        return _entity_list([r[0] for r in c.execute(
            "SELECT DISTINCT geneName FROM genome ORDER BY geneName")], "gene")
    # chrom + start (+ window): the drag/wheel navigation path
    if g("chrom") and g("start") is not None:
        chrom0 = g("chrom")
        start = int(float(g("start")))
        window = int(float(g("window"))) if g("window") else 1000000
        rows = c.execute(_GENCODE_COLS + "WHERE chrom=? AND cdsEnd>=? AND cdsStart<=?",
                         (chrom0, start, start + window)).fetchall()
        return _gencode_tracks(c, rows)
    gene = g("gene")
    if not gene:
        return None
    rows = c.execute(_GENCODE_COLS + "WHERE geneName=?", (gene,)).fetchall()
    return _gencode_tracks(c, rows)


def _gencode_tracks(c, rows):
    if not rows:
        return None
    chrom = rows[0][4]
    gmin, gmax = 10 ** 12, 0
    genes = {"name": "Genes", "type": "box", "connect": "true", "data": []}
    for r in rows:
        if r[4] != chrom:
            continue
        strs = [int(x) for x in str(r[6]).split(",") if x != ""]
        ends = [int(x) for x in str(r[7]).split(",") if x != ""]
        if not strs or not ends:
            continue
        st, en = strs[0], ends[-1]
        gmin, gmax = min(gmin, st), max(gmax, en)
        genes["data"].append({
            "id": r[2], "geneId": r[1], "geneName": r[0], "geneType": r[3],
            "fill": "rgb(0,0,255)", "outline": "rgb(0,0,255)",
            "dir": "right" if r[5] == "+" else "left", "start": st, "end": en, "chrom": chrom,
            "data": [[strs[i], ends[i]] for i in range(min(len(strs), len(ends)))]})
    if not genes["data"]:
        return None
    genes["chrom"], genes["min"], genes["max"] = chrom, gmin, gmax
    gwas = {"name": "GWAS Catalog", "type": "box", "connect": "false", "data": []}
    grows = c.execute("SELECT pubmedid,diseaseTrait,chrom,start,strongestSNPRiskAllele,pValue,ORorBeta "
                      "FROM gwas WHERE chrom=? AND start>=? AND start<=?",
                      (chrom, gmin, gmax + 1)).fetchall()
    for n, r in enumerate(grows):
        st = r[3]
        gwas["data"].append({
            "id": "%d.%d" % (st, n), "hideName": "true", "dir": "right", "pubmedid": r[0],
            "diseaseTrait": r[1], "chrom": r[2], "fill": "rgb(100,100,100)",
            "outline": "rgb(100,100,100)", "start": st, "end": st + 1,
            "strongestSNPRiskAllele": r[4], "pValue": r[5], "ORorBeta": r[6],
            "data": [[st, st + 1]]})
    gwas["chrom"], gwas["min"], gwas["max"] = chrom, gmin, gmax
    return {"tracks": [genes, gwas]}


def _wp_explore(qs):
    c = _cur("wp"); g = _get(qs)
    if g("list") == "pathways":
        rows = c.execute("SELECT DISTINCT name FROM pathway WHERE taxName='Homo sapiens' ORDER BY name").fetchall()
        return _entity_list([r[0] for r in rows], "pathway")
    pathway = g("pathway")
    if pathway:
        rows = c.execute(
            "SELECT g.symbol, COUNT(DISTINCT m2.wpId) hub FROM members m "
            "JOIN gene g ON m.geneId=g.geneId JOIN pathway p ON m.wpId=p.wpId "
            "JOIN members m2 ON m2.geneId=g.geneId "
            "WHERE p.name=? AND p.taxName='Homo sapiens' GROUP BY g.symbol "
            "ORDER BY hub DESC, g.symbol LIMIT 40", (pathway,)).fetchall()
        if not rows:
            return None
        syms = [r[0] for r in rows]
        return _ds1("Pathways containing gene", syms, [r[1] for r in rows], "Gene", syms)
    return None


_EXPLORE = {"tcga": _tcga_explore, "gtex": _gtex_explore,
            "gencode": _gencode_explore, "wp": _wp_explore}

# Query keys that mean "this is an explorer request" (else fall back to source=).
_EXPLORE_KEYS = ("list", "search", "mutations", "type", "trait", "pathway", "gene", "chrom")


def handle(db, qs):
    """Return the `.data` payload for database ``db`` and query params ``qs``
    (a dict of str->str or str->[str]); None if unknown. CCLE dispatches on its
    own query params; the other DBs serve their interactive explorer when an
    explorer key is present, otherwise the aggregate `source=` overview."""
    if db == "ccle":
        return _ccle(qs)
    if db in _AGG:
        if any(k in qs for k in _EXPLORE_KEYS):
            return _EXPLORE[db](qs)
        src = qs.get("source")
        if isinstance(src, list):
            src = src[0] if src else None
        return _AGG[db](src)
    return None
