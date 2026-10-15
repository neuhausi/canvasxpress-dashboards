"""View-time Q&A loop: tool execution + the orchestration (with a fake client)."""

from cxd_server import ask


DATA = {
    "orders": {
        "y": {"vars": ["Revenue"], "smps": ["O1", "O2", "O3"], "data": [[100, 250, 50]]},
        "x": {"Region": ["North", "North", "South"]},
    }
}


# --- a scripted Anthropic-style client (no network) ---------------------------
class Block:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def model_dump(self):
        return dict(self.__dict__)


class Resp:
    def __init__(self, stop_reason, content):
        self.stop_reason = stop_reason
        self.content = content


class FakeClient:
    """Returns the scripted responses in order; records the kwargs it was called with."""

    def __init__(self, scripted):
        self.scripted = scripted
        self.calls = []
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.scripted[len(self.calls) - 1]


def test_execute_runs_tools_against_the_named_source():
    assert ask.execute(DATA, "describe", {"source": "orders"})[0]["records"] == 3
    out, err = ask.execute(DATA, "aggregate",
                           {"source": "orders", "group_by": "Region", "measure": "Revenue"})
    assert not err and out["groups"][0] == {"group": "North", "value": 350}
    top, _ = ask.execute(DATA, "top_n", {"source": "orders", "measure": "Revenue", "n": 1})
    assert top["top"] == [{"id": "O2", "value": 250}]
    cnt, _ = ask.execute(DATA, "filter_count",
                         {"source": "orders", "field": "Region", "op": "eq", "value": "North"})
    assert cnt["count"] == 2


def test_execute_applies_optional_where():
    out, _ = ask.execute(DATA, "top_n", {
        "source": "orders", "measure": "Revenue",
        "where": {"field": "Region", "op": "eq", "value": "North"}})
    assert [r["id"] for r in out["top"]] == ["O2", "O1"]


def test_execute_unknown_source_is_an_error():
    payload, is_error = ask.execute(DATA, "describe", {"source": "nope"})
    assert is_error and "no such source" in payload["error"]


def test_catalog_lists_sources_and_fields():
    cat = ask.catalog(DATA)
    assert "orders" in cat and "Revenue" in cat and "Region" in cat and "3 records" in cat


def test_run_ask_drives_the_tool_loop():
    scripted = [
        Resp("tool_use", [Block(type="tool_use", name="aggregate", id="t1",
                                input={"source": "orders", "group_by": "Region", "measure": "Revenue"})]),
        Resp("end_turn", [Block(type="text", text="North leads with 350 in revenue.")]),
    ]
    client = FakeClient(scripted)
    usages = []
    out = ask.run_ask(client, "fake-model", DATA, "which region has the most revenue?",
                      on_usage=usages.append)
    assert out["answer"] == "North leads with 350 in revenue."
    assert len(out["used"]) == 1
    assert out["used"][0]["tool"] == "aggregate"
    assert out["used"][0]["result"]["groups"][0]["group"] == "North"
    # tools + system catalogue were sent on the first call
    assert client.calls[0]["tools"] == ask.ASK_TOOLS
    assert "orders" in client.calls[0]["system"]
    assert len(usages) == 2   # one per model call


def test_run_ask_returns_text_when_no_tools_needed():
    scripted = [Resp("end_turn", [Block(type="text", text="I can't answer that from this data.")])]
    out = ask.run_ask(FakeClient(scripted), "fake-model", DATA, "what's the weather?")
    assert out["answer"].startswith("I can't answer")
    assert out["used"] == []
