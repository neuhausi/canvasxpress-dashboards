import json, os, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
# Load validate_spec directly by path: it is dependency-free by design, and the
# package __init__ would drag in fastapi.
path = os.path.join(here, "..", "..", "src", "cxd_server", "validate_spec.py")
spec = importlib.util.spec_from_file_location("validate_spec", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
corpus = json.load(open(os.path.join(here, "specs_corpus.json")))
out = {c["name"]: mod.validate_spec(c["spec"]) for c in corpus}
print(json.dumps(out, indent=1))
