"""View-time Q&A orchestration: let a viewer ask a question of a dashboard and
get an answer **computed from the data**.

The language model never sees the raw rows to reason over freely — it is given a
catalogue of the dashboard's sources and a fixed set of read-only tools
(:mod:`cxd_server.ask_tools`), and only the tools' results come back. The model
decides which tools to call; the numbers in the answer come from the tools, not
the model. This module is the loop that drives that; the Anthropic client is
injected so it is unit-tested with a scripted fake (no network, no cost).
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

from . import ask_tools

# The read-only tools exposed to the model. Each takes a `source` (a data ref in
# the dashboard) plus its own arguments; aggregate/top_n accept an optional
# `where` filter so the model can answer "within region X" without a round trip.
ASK_TOOLS: List[Dict[str, Any]] = [
    {"name": "describe",
     "description": "Summarize a data source: record count, its measures (min/max/mean) "
                    "and its categories (distinct values). Call this first to learn the "
                    "field names before using the other tools.",
     "input_schema": {"type": "object",
                      "properties": {"source": {"type": "string"}},
                      "required": ["source"]}},
    {"name": "aggregate",
     "description": "Group records by a category and aggregate a measure within each group.",
     "input_schema": {"type": "object", "properties": {
         "source": {"type": "string"},
         "group_by": {"type": "string", "description": "a category field"},
         "measure": {"type": "string", "description": "a measure field"},
         "agg": {"type": "string", "enum": ["sum", "avg", "min", "max", "count"]},
         "where": {"type": "object", "description": "optional pre-filter {field, op, value}",
                   "properties": {"field": {"type": "string"},
                                  "op": {"type": "string",
                                         "enum": ["eq", "ne", "gt", "lt", "ge", "le", "contains"]},
                                  "value": {}}}},
         "required": ["source", "group_by", "measure"]}},
    {"name": "top_n",
     "description": "The records with the highest (or lowest) value of a measure.",
     "input_schema": {"type": "object", "properties": {
         "source": {"type": "string"},
         "measure": {"type": "string"},
         "n": {"type": "integer"},
         "ascending": {"type": "boolean"},
         "where": {"type": "object",
                   "properties": {"field": {"type": "string"},
                                  "op": {"type": "string",
                                         "enum": ["eq", "ne", "gt", "lt", "ge", "le", "contains"]},
                                  "value": {}}}},
         "required": ["source", "measure"]}},
    {"name": "filter_count",
     "description": "How many records match a condition on one field.",
     "input_schema": {"type": "object", "properties": {
         "source": {"type": "string"},
         "field": {"type": "string"},
         "op": {"type": "string", "enum": ["eq", "ne", "gt", "lt", "ge", "le", "contains"]},
         "value": {}},
         "required": ["source", "field", "op", "value"]}},
]

_SYSTEM = (
    "You answer questions about a specific dashboard's data. You are given a catalogue of its "
    "data sources and read-only tools to query them. ALWAYS compute figures with the tools — "
    "never estimate or invent a number. Call `describe` first to learn a source's field names. "
    "When you have enough, reply with a short, direct answer in plain language, citing the "
    "figures you found. If the tools cannot answer it, say so plainly."
)


def catalog(data_by_ref: Dict[str, Dict[str, Any]]) -> str:
    """A compact catalogue of the dashboard's sources and their fields for the prompt.

    :param data_by_ref: Resolved data per source ref.
    :returns: A human/model-readable catalogue string.
    """
    lines = ["Data sources in this dashboard:"]
    for ref, data in data_by_ref.items():
        f = ask_tools.fields(data)
        n = len((data.get("y") or {}).get("smps") or [])
        lines.append("- \"%s\": %d records; measures=%s; categories=%s" % (
            ref, n, ", ".join(f["measures"]) or "(none)", ", ".join(f["categories"])))
    return "\n".join(lines)


def execute(data_by_ref: Dict[str, Dict[str, Any]], name: str, args: Dict[str, Any]):
    """Run one tool call against the named source. Returns (payload, is_error).

    :param data_by_ref: Resolved data per source ref.
    :param name: The tool name.
    :param args: The tool arguments (must include ``source``).
    :returns: ``(payload_dict, is_error_bool)``.
    """
    args = dict(args or {})
    source = args.pop("source", None)
    data = data_by_ref.get(source)
    if data is None:
        return {"error": "no such source: %s (known: %s)" % (source, ", ".join(data_by_ref))}, True
    try:
        where = args.pop("where", None)
        rows = None
        if where and isinstance(where, dict) and where.get("field") and where.get("op"):
            rows = ask_tools.filter_rows(data, where["field"], where["op"], where.get("value"))
        if name == "describe":
            return ask_tools.describe(data), False
        if name == "filter_count":
            matched = ask_tools.filter_rows(data, args["field"], args["op"], args.get("value"))
            return {"count": len(matched)}, False
        if name == "aggregate":
            return {"groups": ask_tools.aggregate(
                data, args["group_by"], args["measure"], args.get("agg", "sum"), rows=rows)}, False
        if name == "top_n":
            return {"top": ask_tools.top_n(
                data, args["measure"], args.get("n", 5), args.get("ascending", False), rows=rows)}, False
        return {"error": "unknown tool: %s" % name}, True
    except (KeyError, ValueError) as exc:
        return {"error": str(exc)}, True


def run_ask(client, model: str, data_by_ref: Dict[str, Dict[str, Any]], question: str,
            max_rounds: int = 6, max_tokens: int = 1024,
            on_usage: Optional[Callable[[Any], None]] = None) -> Dict[str, Any]:
    """Drive the bounded tool-use loop and return the answer plus what it used.

    :param client: An Anthropic-style client with ``messages.create(...)``.
    :param model: The model id.
    :param data_by_ref: Resolved data per source ref (the tools run against these).
    :param question: The viewer's question.
    :param max_rounds: Tool-use loop bound.
    :param max_tokens: Per-call output cap.
    :param on_usage: Optional callback given each response (for cost accounting).
    :returns: ``{"answer": str, "used": [{"tool", "args", "result"}...]}``.
    """
    system = _SYSTEM + "\n\n" + catalog(data_by_ref)
    messages: List[Dict[str, Any]] = [{"role": "user", "content": question}]
    used: List[Dict[str, Any]] = []
    response = None
    for _round in range(max_rounds):
        response = client.messages.create(model=model, max_tokens=max_tokens,
                                           system=system, tools=ASK_TOOLS, messages=messages)
        if on_usage:
            on_usage(response)
        if getattr(response, "stop_reason", None) != "tool_use":
            break
        messages.append({"role": "assistant",
                         "content": [_to_dict(b) for b in response.content]})
        results = []
        for block in response.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            payload, is_error = execute(data_by_ref, block.name, block.input)
            used.append({"tool": block.name, "args": block.input, "result": payload})
            results.append({"type": "tool_result", "tool_use_id": block.id,
                            "content": json.dumps(payload), "is_error": is_error})
        messages.append({"role": "user", "content": results})
    answer = ""
    if response is not None:
        answer = "".join(getattr(b, "text", "") for b in response.content
                         if getattr(b, "type", None) == "text").strip()
    return {"answer": answer, "used": used}


def _to_dict(block):
    """A content block as a plain dict (model objects expose model_dump)."""
    if hasattr(block, "model_dump"):
        return block.model_dump()
    return block
