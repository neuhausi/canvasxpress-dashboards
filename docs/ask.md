# Ask: view-time questions about a dashboard's data

A signed-in viewer can **ask a question of a dashboard's data** and get an answer
*computed from the numbers* — not guessed by a language model. Open a dashboard
in the viewer, click **✨ Ask**, and type a question like "which region has the
highest revenue?" or "how many orders are above 200?". The answer comes back with
the **figures it used** so you can check the work.

## Why it's trustworthy

The model never sees the raw rows to reason over freely. It's given a catalogue
of the dashboard's data sources and a fixed set of **read-only tools** —
`describe`, `aggregate`, `top_n`, `filter_count` (see `server/.../ask_tools.py`) —
and only the tools' *results* come back. Every number in the answer is computed
by a tool against the real data; there is **no `eval` and no free-form SQL**.
Row/column security applies to the data the tools see, so an ask can never read
rows the viewer couldn't.

## Using it

1. Open a dashboard in the **viewer** (`view.html?id=…`) while signed in.
2. Click **✨ Ask** (bottom-left). It appears only for users allowed to use AI
   (the `llm.use` permission).
3. Ask in plain language. Expand **Figures used** under the answer to see each
   tool call and what it returned.

## API

```
POST /api/dashboards/{id}/ask      { "question": "..." }   (?owner= for a shared board)
  → { "answer": "...", "used": [ { "tool", "args", "result" }, ... ] }
```

- Requires the `llm.use` permission and view access to the dashboard.
- `400` when the question is empty; `422` when the dashboard has no inspectable
  data; `503` when the server has no AI configured (`CXD_LLM_API_KEY`).
- The loop is bounded (a few tool rounds, a small token cap) and audited.

## Configuration

The ask endpoint uses the same LLM configuration as the AI dashboard builder:
`CXD_LLM_API_KEY` (required to enable it), and optionally `CXD_LLM_MODEL`,
`CXD_LLM_BASE_URL`, `CXD_LLM_KEY_HEADER`. With no key, the **✨ Ask** box still
appears for permitted users but every ask returns a clear "AI is not configured"
message.

## Scope

Today the tools answer over the dashboard's **inline and dataset** sources
(dataset data is resolved server-side with the viewer's security applied). It
answers questions that reduce to describe / filter / aggregate / top-N / compare
over those sources; it does not run arbitrary analysis or modify the dashboard
(that's the AI *builder*).
