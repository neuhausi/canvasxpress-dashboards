import html
import json
import re

import pytest

from canvasxpress_dashboards import Dashboard, ENGINE_URL, dashboard

SPEC = {"id": "demo", "title": "Demo", "layout": {"cols": 12, "items": []}, "data": {}, "panels": {}}
COHORT = {"patient": ["P1", "P2", "P3"], "os_months": [3, 9, 5], "os_event": [0, 1, 1], "age": [40, 50, 60]}


def embedded_payload(page):
    """The payload object a standalone page hands to renderPayload (parsed back out of the page)."""
    match = re.search(r"renderPayload\(document\.getElementById\('cxd-root'\), (\{.*?\}), \{ idPrefix", page, re.S)
    assert match, "no renderPayload call in the page"
    return json.loads(match.group(1))


def test_a_spec_dashboard_carries_the_spec_and_overrides():
    d = Dashboard(SPEC, title="Mine", theme="dark")
    p = d.payload()
    assert p["suggest"] is False and json.loads(p["specJson"]) == SPEC
    assert p["title"] == "Mine" and p["theme"] == "dark" and "dataJson" not in p
    assert d.to_dict() == SPEC


def test_a_data_dashboard_carries_data_and_is_suggested():
    d = Dashboard(data=COHORT, id="patient")
    p = d.payload()
    assert p["suggest"] is True and "specJson" not in p
    data = json.loads(p["dataJson"])
    assert data["y"]["vars"] == ["os_months", "os_event", "age"] and data["y"]["smps"] == ["P1", "P2", "P3"]
    assert d.to_dict() is None


def test_a_canvasxpress_data_object_is_accepted_as_is():
    obj = {"y": {"vars": ["a"], "smps": ["r1"], "data": [[1]]}}
    assert json.loads(Dashboard(data=obj).payload()["dataJson"]) == obj


def test_arguments_are_validated():
    with pytest.raises(ValueError, match="give a `spec`"):
        Dashboard()
    with pytest.raises(ValueError, match="not both"):
        Dashboard(SPEC, data=COHORT)
    with pytest.raises(ValueError, match="not valid JSON"):
        Dashboard("{broken")


def test_the_page_is_standalone_and_carries_engine_bundle_and_payload():
    page = Dashboard(SPEC).to_html()
    assert page.startswith("<!doctype html>")
    assert ENGINE_URL + "/canvasXpress.min.js" in page and ENGINE_URL + "/canvasXpress.css" in page
    assert "CanvasXpressDashboards" in page and len(page) > 500_000          # the bundle is inlined
    assert embedded_payload(page)["suggest"] is False
    assert json.loads(embedded_payload(page)["specJson"]) == SPEC


def test_bundle_url_and_engine_url_replace_the_defaults():
    page = Dashboard(SPEC, engine_url="https://example.org/cx/", bundle_url="https://example.org/d.js").to_html()
    assert 'src="https://example.org/cx/canvasXpress.min.js"' in page
    assert '<script src="https://example.org/d.js"></script>' in page
    assert len(page) < 20_000                                                # nothing inlined


def test_data_cannot_break_out_of_the_script_element():
    hostile = "</script><script>window.pwned=1</script>"
    cols = {"id": [hostile, "b"], "n": [1, 2], "note": [hostile, "x"]}
    page = Dashboard(data=cols, id="id", title=hostile).to_html()
    tail = page[page.index("renderPayload(document"):]                       # the payload, after the bundle
    assert "</script><script>window.pwned" not in tail
    assert hostile not in tail
    assert embedded_payload(page)["title"] == hostile                       # ...and it still round-trips intact
    assert json.loads(embedded_payload(page)["dataJson"])["y"]["smps"][0] == hostile


def test_line_separators_do_not_end_the_script():
    page = Dashboard(SPEC, title="a b c").to_html()
    assert " " not in page.split("renderPayload(document")[1]
    assert embedded_payload(page)["title"] == "a b c"


def test_the_notebook_output_is_an_iframe_that_follows_the_dashboard():
    d = Dashboard(SPEC, height=500)
    out = d._repr_html_()
    assert out.startswith("<iframe") and 'srcdoc="' in out and "height:500px" in out
    frame = re.search(r'srcdoc="(.*?)" style=', out, re.S).group(1)
    inner = html.unescape(frame)
    assert inner.startswith("<!doctype html>")                              # the whole page, attribute-escaped
    assert "cxd-resize" in inner and "cxd-params" in inner                    # the frame reports to the host
    assert 'id="%s"' % d.frame_id in out
    assert "cxd-resize" in out.split("</iframe>")[1] and json.dumps(d.frame_id) in out.split("</iframe>")[1]
    assert out.count("<iframe") == 1


def test_a_plain_page_does_not_post_messages_but_a_framed_one_does():
    assert "postMessage" not in Dashboard(SPEC).to_html().split("renderPayload(document")[1]
    assert "postMessage" in Dashboard(SPEC).to_html(frame=True).split("renderPayload(document")[0].split("</script>")[-1]


def test_frame_ids_differ_between_dashboards():
    assert Dashboard(SPEC).frame_id != Dashboard(SPEC).frame_id


def test_save_writes_a_standalone_page(tmp_path):
    path = Dashboard(SPEC).save(tmp_path / "d.html")
    assert path.endswith("d.html") and open(path, encoding="utf-8").read().startswith("<!doctype html>")


def test_show_opens_a_saved_page(monkeypatch):
    opened = []
    monkeypatch.setattr("canvasxpress_dashboards.widget.webbrowser.open", lambda url: opened.append(url))
    path = Dashboard(SPEC).show()
    assert opened == ["file://" + path] and open(path, encoding="utf-8").read().startswith("<!doctype html>")


def test_shorthand_and_repr():
    assert isinstance(dashboard(SPEC), Dashboard)
    assert "spec 'demo'" in repr(Dashboard(SPEC)) and "suggested" in repr(Dashboard(data=COHORT, id="patient"))
