#!/usr/bin/env python3
"""NL -> dashboard eval: does the builder produce specs that actually work?

Scores each plain-English prompt on three things:

  produced   the model returned a spec at all (vs a conversational reply)
  structural validate_spec() passes — the spec is internally consistent
  bindings   validate_bindings() passes — it references datasets/columns that
             really exist (the check the browser-side validator cannot do)

A prompt "passes" only when all three hold. Two prompts are deliberately
adversarial: p18 is vague, and p19 asks for columns the dataset does not have —
a model that invents columns should fail `bindings`, not slip through.

Requires a RUNNING dashboards server with the NL builder configured
(CXD_LLM_API_KEY). Every run costs real API tokens — 20 prompts per run.

    python3 run_eval.py --url http://127.0.0.1:8200 --user evaluser --password evalpass
    python3 run_eval.py --only p01,p02          # cheap subset while iterating
"""

import argparse
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_validator():
    """Load validate_spec.py by path (dependency-free; avoids the fastapi import)."""
    path = os.path.join(HERE, "..", "..", "src", "cxd_server", "validate_spec.py")
    spec = importlib.util.spec_from_file_location("validate_spec", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Client:
    """Tiny cookie-aware JSON client for the dashboards API."""

    def __init__(self, base):
        self.base = base.rstrip("/")
        self.cookie = None

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                set_cookie = resp.headers.get("Set-Cookie")
                if set_cookie:
                    self.cookie = set_cookie.split(";")[0]
                text = resp.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()[:300]
            raise RuntimeError("%s %s -> %s %s" % (method, path, exc.code, detail))


def ensure_login(client, user, password):
    """Log in, signing the eval user up first if they do not exist yet."""
    for path in ("/auth/login", "/auth/signup"):
        try:
            client.call("POST", path, {"username": user, "password": password})
            return
        except RuntimeError:
            continue
    raise SystemExit("could not log in or sign up as %r" % user)


def ensure_datasets(client, fixtures):
    """Create each fixture dataset, reusing it when already present."""
    existing = {d.get("title"): d.get("id")
                for d in (client.call("GET", "/api/datasets") or {}).get("datasets", [])}
    ids = {}
    for key, fx in fixtures.items():
        if fx["title"] in existing:
            ids[key] = existing[fx["title"]]
            continue
        res = client.call("POST", "/api/datasets",
                          {"title": fx["title"], "format": fx["format"], "data": fx["data"]})
        ids[key] = res["dataset"]["id"]
    return ids


def columns_for(fixture):
    """Column names for a fixture: y.vars plus x/z annotation keys."""
    y = fixture["data"].get("y") or {}
    cols = list(y.get("vars") or [])
    for annot in ("x", "z"):
        cols.extend((fixture["data"].get(annot) or {}).keys())
    return cols


def meets_expectation(spec, expect):
    """Did the spec actually do what the prompt asked for?

    A structurally-valid spec that silently ignores the request is still a
    failure for the user — this is the axis `structural`/`bindings` cannot see.
    Supported expectations: ``has_key`` (key present anywhere in the tree),
    ``panel_type`` (a panel of that type exists), ``control_mode`` (a control
    panel in that mode exists).

    :returns: (met, note) — note explains a miss.
    """
    if not expect:
        return True, ""
    panels = (spec.get("panels") or {}) if isinstance(spec, dict) else {}

    key = expect.get("has_key")
    if key:
        found = [False]

        def walk(node):
            if found[0]:
                return
            if isinstance(node, dict):
                if key in node:
                    found[0] = True
                    return
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(spec)
        if not found[0]:
            return False, "no '%s' anywhere in the spec" % key

    top_key = expect.get("has_top_key")
    if top_key and (not isinstance(spec, dict) or top_key not in spec):
        return False, "no top-level '%s' on the spec" % top_key

    style = expect.get("control_style")
    if style and not any(isinstance(p, dict) and p.get("type") == "control"
                         and p.get("style") == style for p in panels.values()):
        return False, "no control panel with style '%s'" % style

    ptype = expect.get("panel_type")
    if ptype and not any(isinstance(p, dict) and p.get("type") == ptype
                         for p in panels.values()):
        return False, "no panel of type '%s'" % ptype

    mode = expect.get("control_mode")
    if mode and not any(isinstance(p, dict) and p.get("type") == "control"
                        and p.get("mode") == mode for p in panels.values()):
        return False, "no control panel with mode '%s'" % mode

    return True, ""


def replay(args):
    """Re-score a saved run from its stored specs — free, and instant.

    Every API response is expensive, so a results file keeps each spec. Changing
    an expectation or a validator rule should never mean paying to regenerate
    the same specs; replay re-runs only the scoring.
    """
    validator = _load_validator()
    fixtures = json.load(open(os.path.join(HERE, "fixtures.json")))
    prompts = {p["id"]: p for p in json.load(open(os.path.join(HERE, args.prompts)))}
    saved = json.load(open(args.replay))

    # Rebuild the column map from the saved specs' dataset ids.
    known_columns = {}
    for row in saved["results"]:
        for src_ in ((row.get("spec") or {}).get("data") or {}).values():
            if isinstance(src_, dict) and src_.get("kind") == "dataset" and src_.get("id"):
                for key, fx in fixtures.items():
                    if key in row.get("message", "").lower() or True:
                        known_columns.setdefault(src_["id"], columns_for(fx))

    results = []
    for row in saved["results"]:
        spec = row.get("spec")
        prompt = prompts.get(row["id"], {})
        new_row = {k: row[k] for k in ("id", "message", "reply", "produced") if k in row}
        if spec is None:
            new_row.update(structural=False, bindings=False, intent=False,
                           errors=["no spec returned"])
        else:
            structural = validator.validate_spec(spec)
            bindings = validator.validate_bindings(spec, known_columns)
            met, note = meets_expectation(spec, prompt.get("expect"))
            new_row.update(structural=structural["valid"], bindings=bindings["valid"],
                           intent=met, spec=spec,
                           errors=structural["errors"] + bindings["errors"]
                           + ([] if met else ["did not fulfil the request: " + note]))
        new_row["pass"] = bool(new_row.get("produced") and new_row.get("structural")
                               and new_row.get("bindings") and new_row.get("intent"))
        results.append(new_row)
        print("  %s  %s  %s" % (new_row["id"], "PASS" if new_row["pass"] else "FAIL",
                                "; ".join(new_row.get("errors") or [])[:150]))

    passed = sum(1 for r in results if r["pass"])
    print("\n== REPLAY (no API cost) %d/%d passed ==" % (passed, len(results)))
    json.dump({"summary": {"total": len(results), "passed": passed},
               "results": results}, open(args.out, "w"), indent=1)
    print("wrote " + args.out)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.getenv("CXD_EVAL_URL", "http://127.0.0.1:8200"))
    ap.add_argument("--user", default=os.getenv("CXD_EVAL_USER", "evaluser"))
    ap.add_argument("--password", default=os.getenv("CXD_EVAL_PASSWORD", "evalpass"))
    ap.add_argument("--only", help="comma-separated prompt ids to run")
    ap.add_argument("--prompts", default="prompts.json",
                    help="prompt file to run (default prompts.json)")
    ap.add_argument("--out", default=os.path.join(HERE, "results.json"))
    ap.add_argument("--replay", help=("re-score a previous results file offline "
                                      "(no API calls, no cost) — use after changing "
                                      "expectations or the validator"))
    args = ap.parse_args()

    if args.replay:
        return replay(args)

    validator = _load_validator()
    fixtures = json.load(open(os.path.join(HERE, "fixtures.json")))
    prompts = json.load(open(os.path.join(HERE, args.prompts)))
    if args.only:
        wanted = set(args.only.split(","))
        prompts = [p for p in prompts if p["id"] in wanted]

    client = Client(args.url)
    ensure_login(client, args.user, args.password)
    dataset_ids = ensure_datasets(client, fixtures)
    # dataset id -> real column names, for the binding check
    known_columns = {dataset_ids[k]: columns_for(fx) for k, fx in fixtures.items()}

    results = []
    for prompt in prompts:
        scoped = [dataset_ids[k] for k in prompt["datasets"]]
        row = {"id": prompt["id"], "message": prompt["message"]}
        try:
            res = client.call("POST", "/api/llm/dashboard",
                              {"message": prompt["message"], "datasets": scoped})
        except RuntimeError as exc:
            row.update(error=str(exc), produced=False, structural=False, bindings=False)
            results.append(row)
            print("  %s  ERROR %s" % (prompt["id"], exc))
            continue

        spec = res.get("spec")
        row["reply"] = (res.get("reply") or "")[:120]
        row["produced"] = spec is not None
        if spec is None:
            row.update(structural=False, bindings=False, errors=["no spec returned"])
        else:
            structural = validator.validate_spec(spec)
            bindings = validator.validate_bindings(spec, known_columns)
            row["structural"] = structural["valid"]
            row["bindings"] = bindings["valid"]
            row["errors"] = structural["errors"] + bindings["errors"]
            row["panels"] = len((spec.get("panels") or {}))
            row["spec"] = spec          # kept so re-scoring needs no API call
            met, note = meets_expectation(spec, prompt.get("expect"))
            row["intent"] = met
            if not met:
                row["errors"].append("did not fulfil the request: " + note)
        row.setdefault("intent", not prompt.get("expect"))
        row["pass"] = bool(row["produced"] and row["structural"]
                           and row["bindings"] and row["intent"])
        results.append(row)
        print("  %s  %s  %s" % (prompt["id"], "PASS" if row["pass"] else "FAIL",
                                "; ".join(row.get("errors") or [])[:150]))

    total = len(results)
    summary = {
        "total": total,
        "produced": sum(1 for r in results if r.get("produced")),
        "structural": sum(1 for r in results if r.get("structural")),
        "bindings": sum(1 for r in results if r.get("bindings")),
        "intent": sum(1 for r in results if r.get("intent")),
        "passed": sum(1 for r in results if r.get("pass")),
    }
    json.dump({"summary": summary, "results": results}, open(args.out, "w"), indent=1)
    print("\n== %d/%d passed ==  produced %d | structural %d | bindings %d | intent %d"
          % (summary["passed"], total, summary["produced"],
             summary["structural"], summary["bindings"], summary["intent"]))
    print("wrote " + args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
