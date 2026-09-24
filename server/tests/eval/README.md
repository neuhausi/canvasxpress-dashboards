# NL → dashboard eval

Measures whether the plain-English dashboard builder produces specs that
actually work. Every run costs real API tokens, so read this before running.

## Scoring

Each prompt is scored on four axes; a prompt passes only when all four hold.

| Axis | Question |
|---|---|
| `produced`   | did the model return a spec at all? |
| `structural` | does `validate_spec()` pass — is the spec internally consistent? |
| `bindings`   | does `validate_bindings()` pass — do datasets/columns exist? |
| `intent`     | did it actually do what was asked (`expect` in the prompt file)? |

`intent` exists because a structurally-valid spec that silently ignores the
request still fails the user — the failure mode `structural` cannot see.

## Running it

Needs a dashboards server with the NL builder configured (`CXD_LLM_API_KEY`).

    python3 run_eval.py --url http://127.0.0.1:8200                        # the 20 core prompts
    python3 run_eval.py --prompts prompts_features.json --url ...          # the 8 feature prompts
    python3 run_eval.py --only p01,p08 --url ...                           # cheap subset while iterating
    python3 run_eval.py --replay <results.json> --prompts prompts.json     # re-score offline, FREE

Prefer `--only` while iterating and keep the full suite as a pre-commit gate.
`--replay` re-scores saved specs with no API calls — use it after changing an
expectation or a validator rule, instead of paying to regenerate identical
specs.

## Render check (free)

`--render` renders every generated spec with the real CanvasXpress engine
(`render_check.cjs`, headless Chromium) and adds a `render` axis. It fails a
chart when the engine silently replaced the axes the spec named, when a
grouping / colour annotation is missing from the panel's data, when a Pie is a
single 100% slice, or when nothing was drawn. It needs the server running (the
eval user's datasets and functions resolve through it), Playwright
(`PLAYWRIGHT_MODULE` to reuse an install) and CanvasXpress (`CX_LIB_DIR` /
`CX_CSS_DIR`, else the CDN). It works with `--replay` too, so re-checking saved
specs costs nothing:

    python3 run_eval.py --prompts prompts_blend.json --render --url ...
    python3 run_eval.py --replay results.json --render --url ...

`prompts_blend.json` (8 prompts) covers joins, relationships, Filters panels and R /
Python functions; the `labs` fixture joins to `trial` on its `patient` column.
Results also record each prompt's server-reported cost (`cost`, `cost_usd`).

## Validator parity

`run_js.mjs` and `run_py.py` run the JS `validateSpec` and the Python
`validate_spec` over `specs_corpus.json` (53 specs) and their output is
compared; they must agree exactly.

    node run_js.mjs > /tmp/js.json && python3 run_py.py > /tmp/py.json && diff /tmp/js.json /tmp/py.json

## Measured results (2026-09-09)

| Suite | Before | After |
|---|---|---|
| Core prompts (20)    | 19/20 | 20/20 |
| Feature prompts (8)  |  4/8  |  8/8  |

Every fix came from documenting capabilities the model was never told about —
the schema supported them, the system prompt did not. Failures came in three
shapes: outright refusal ("dashboards don't support dropdowns"), silent
omission (a valid dashboard missing the requested cross-filter), and using the
wrong mechanism (per-chart `config.theme` instead of the dashboard `theme`).

Two prompts are deliberately adversarial: `p18` is vague, and `p19` asks for
columns the dataset does not have — a model that invents columns must fail
`bindings` rather than slip through.
