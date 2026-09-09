"""Server-side dashboard-spec validation.

A dependency-free Python port of ``src/validateSpec.js`` (the browser-side
runtime guard), plus the binding checks the JS version cannot perform because
it has no dataset catalogue.

Why this exists: the LLM builder runs server-side, so spec errors have to be
detectable server-side to be repairable. Previously ``validateSpec`` ran only
in the browser, which meant errors were reported to the user *after* the round
trip and the model never saw them.

Keep :func:`validate_spec` in sync with ``src/validateSpec.js`` — the canonical
contract for both is ``schema/dashboard.schema.json``.
"""

from __future__ import annotations

from typing import Any, Optional

_FIT = ("contain", "cover", "fill", "none", "scale-down")
_STYLE = ("auto", "dropdown", "radio", "buttons", "search", "slider")
_ALIGN = ("left", "center", "right")
_VALIGN = ("top", "middle", "bottom")
_PARAM_TYPES = ("string", "number", "boolean")
_DATA_KINDS = ("inline", "connector", "dataset")


def _is_int(value: Any) -> bool:
    """Integer check that excludes bool (``True`` is an int in Python)."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_obj(value: Any) -> bool:
    """True for a JSON object (dict), not a list and not None."""
    return isinstance(value, dict)


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


def validate_spec(spec: Any) -> dict:
    """Validate a dashboard spec's structure and internal references.

    Mirrors ``validateSpec.js`` error-for-error so client and server agree.

    :param spec: the dashboard spec to check.
    :returns: ``{"valid": bool, "errors": [str, ...]}``.
    """
    errors: list = []

    if not _is_obj(spec):
        return {"valid": False, "errors": ["spec must be an object"]}

    if not _is_str(spec.get("id")) or not spec.get("id"):
        errors.append("spec.id is required and must be a non-empty string")

    version = spec.get("version")
    if version is not None and not (_is_int(version) and version >= 1):
        errors.append("spec.version must be an integer >= 1")

    panels = spec.get("panels")
    data = spec.get("data")
    params = spec.get("params")

    _check_layout(spec, panels, errors)
    _check_panels(panels, data, params, errors)
    _check_data(data, params, errors)
    _check_params(params, errors)
    _check_controls(spec.get("controls"), data, errors)

    return {"valid": not errors, "errors": errors}


def _check_layout(spec: dict, panels: Any, errors: list) -> None:
    """Validate spec.layout and that every item references a real panel."""
    layout = spec.get("layout")
    if not _is_obj(layout):
        errors.append("spec.layout is required and must be an object")
        return

    items = layout.get("items")
    if not isinstance(items, list):
        errors.append("spec.layout.items is required and must be an array")
    else:
        for i, item in enumerate(items):
            at = "spec.layout.items[%d]" % i
            if not _is_obj(item):
                errors.append(at + " must be an object")
                continue
            panel = item.get("panel")
            if not _is_str(panel):
                errors.append(at + ".panel is required and must be a string")
            elif not _is_obj(panels) or panel not in panels:
                errors.append(at + '.panel "%s" has no matching entry in spec.panels' % panel)
            for key in ("x", "y", "w", "h"):
                if not _is_int(item.get(key)):
                    errors.append(at + "." + key + " is required and must be an integer")
            for key, floor in (("w", 1), ("h", 1), ("x", 0), ("y", 0)):
                value = item.get(key)
                if _is_int(value) and value < floor:
                    errors.append(at + ".%s must be >= %d" % (key, floor))

    cols = layout.get("cols")
    if cols is not None and not (_is_int(cols) and cols >= 1):
        errors.append("spec.layout.cols must be an integer >= 1")


def _check_panels(panels: Any, data: Any, params: Any, errors: list) -> None:
    """Validate every panel: data requirement, control wiring, references."""
    if not _is_obj(panels):
        errors.append("spec.panels is required and must be an object map")
        return

    for key, panel in panels.items():
        at = 'spec.panels["%s"]' % key
        if not _is_obj(panel):
            errors.append(at + " must be an object")
            continue

        ptype = panel.get("type")
        # A param control sourcing choices statically (`options`), from another
        # dataset (`optionsFrom`), or as free text (`style:"search"`) drives a
        # backend query and needs no data of its own — exempt from the data
        # requirement. A config control likewise drives a target panel.
        param_with_options = ptype == "control" and panel.get("mode") == "param" and (
            isinstance(panel.get("options"), list)
            or panel.get("optionsFrom") is not None
            or panel.get("style") == "search")
        is_config_control = ptype == "control" and panel.get("mode") == "config"

        if (ptype not in ("text", "image") and not param_with_options
                and not is_config_control
                and panel.get("dataRef") is None and panel.get("data") is None):
            errors.append(at + " must have either a dataRef or inline data")

        if ptype == "image":
            if panel.get("src") is not None and not _is_str(panel.get("src")):
                errors.append(at + ".src must be a string (URL or data: URI)")
            if panel.get("fit") is not None and panel.get("fit") not in _FIT:
                errors.append(at + '.fit must be "contain", "cover", "fill", "none", or "scale-down"')

        if ptype == "control":
            _check_control_panel(panel, panels, data, params, at, errors)

        if panel.get("align") is not None and panel.get("align") not in _ALIGN:
            errors.append(at + '.align must be "left", "center", or "right"')
        if panel.get("valign") is not None and panel.get("valign") not in _VALIGN:
            errors.append(at + '.valign must be "top", "middle", or "bottom"')

        data_ref = panel.get("dataRef")
        if data_ref is not None and (not _is_obj(data) or data_ref not in data):
            errors.append(at + '.dataRef "%s" has no matching entry in spec.data' % data_ref)

        # Chart-click cross-filter: a clicked mark sets this parameter.
        click_param = panel.get("clickParam")
        if click_param is not None:
            if not _is_str(click_param):
                errors.append(at + ".clickParam must be a string")
            elif not _is_obj(params) or click_param not in params:
                errors.append(at + '.clickParam "%s" has no matching entry in spec.params' % click_param)


def _check_control_panel(panel: dict, panels: Any, data: Any, params: Any,
                         at: str, errors: list) -> None:
    """Validate a control panel's compartment/style/mode and mode wiring."""
    compartment = panel.get("compartment")
    if compartment is not None and compartment not in ("x", "z"):
        errors.append(at + '.compartment must be "x" (samples) or "z" (variables)')

    if panel.get("style") is not None and panel.get("style") not in _STYLE:
        errors.append(at + '.style must be "auto", "dropdown", "radio", "buttons", "search", or "slider"')

    mode = panel.get("mode")
    if mode is not None and mode not in ("filter", "param", "config"):
        errors.append(at + '.mode must be "filter", "param", or "config"')

    if mode == "config":
        target = panel.get("target")
        if not _is_str(target) or not target:
            errors.append(at + ' of mode "config" requires a target panel id string')
        elif not _is_obj(panels) or target not in panels:
            errors.append(at + '.target "%s" has no matching entry in spec.panels' % target)
        options = panel.get("options")
        if not isinstance(options, list) or not options:
            errors.append(at + ' of mode "config" requires a non-empty options array')
        else:
            for oi, opt in enumerate(options):
                if not _is_obj(opt) or not _is_obj(opt.get("config")):
                    errors.append(at + ".options[%d] must be an object with a config fragment" % oi)

    if mode == "param":
        name = panel.get("param")
        if not _is_str(name) or not name:
            errors.append(at + ' of mode "param" requires a param name string')
        elif not _is_obj(params) or name not in params:
            errors.append(at + '.param "%s" has no matching entry in spec.params' % name)
        options_from = panel.get("optionsFrom")
        if options_from is not None:
            if not _is_obj(options_from):
                errors.append(at + ".optionsFrom must be an object")
            elif not _is_str(options_from.get("dataRef")) or \
                    not _is_obj(data) or options_from.get("dataRef") not in data:
                errors.append(at + ".optionsFrom.dataRef has no matching entry in spec.data")


def _check_data(data: Any, params: Any, errors: list) -> None:
    """Validate spec.data sources and their $param query tokens."""
    if data is None:
        return
    if not _is_obj(data):
        errors.append("spec.data must be an object map")
        return

    for key, src in data.items():
        at = 'spec.data["%s"]' % key
        if not _is_obj(src):
            errors.append(at + " must be an object")
            continue
        kind = src.get("kind")
        if kind not in _DATA_KINDS:
            errors.append(at + '.kind must be "inline", "connector", or "dataset"')
        if kind == "inline" and src.get("value") is None:
            errors.append(at + ' of kind "inline" requires a value')
        if kind == "connector" and not _is_str(src.get("url")):
            errors.append(at + ' of kind "connector" requires a url string')
        if kind == "dataset" and (not _is_str(src.get("id")) or not src.get("id")):
            errors.append(at + ' of kind "dataset" requires an id string')

        # A `query` template maps request keys to literals or "$param" tokens;
        # every token must name a declared parameter.
        query = src.get("query")
        if query is not None:
            if not _is_obj(query):
                errors.append(at + ".query must be an object map")
            else:
                for qk, token in query.items():
                    if _is_str(token) and token.startswith("$"):
                        name = token[1:]
                        if not _is_obj(params) or name not in params:
                            errors.append(at + '.query["%s"] references undeclared param "%s"' % (qk, name))


def _check_params(params: Any, errors: list) -> None:
    """Validate spec.params — a bare default value or a {value, type} object."""
    if params is None:
        return
    if not _is_obj(params):
        errors.append("spec.params must be an object map")
        return
    for name, definition in params.items():
        if _is_obj(definition) and definition.get("type") is not None \
                and definition.get("type") not in _PARAM_TYPES:
            errors.append('spec.params["%s"].type must be "string", "number", or "boolean"' % name)


def _check_controls(controls: Any, data: Any, errors: list) -> None:
    """Validate the top-level controls array."""
    if controls is None:
        return
    if not isinstance(controls, list):
        errors.append("spec.controls must be an array")
        return
    for i, control in enumerate(controls):
        at = "spec.controls[%d]" % i
        if not _is_obj(control):
            errors.append(at + " must be an object")
            continue
        if control.get("kind") not in ("filter", "table"):
            errors.append(at + '.kind must be "filter" or "table"')
        ref = control.get("dataRef")
        if ref is not None and (not _is_obj(data) or ref not in data):
            errors.append(at + '.dataRef "%s" has no matching entry in spec.data' % ref)


# ---------------------------------------------------------------------------
# Binding checks — beyond validateSpec.js, which has no dataset catalogue
# ---------------------------------------------------------------------------

def validate_bindings(spec: Any, known_columns: dict) -> dict:
    """Check that the spec binds to datasets and columns that actually exist.

    ``validateSpec`` proves the spec is internally consistent; this proves it
    is consistent with the user's *data*. Catching a dataset id the model
    invented, or a measure naming a column that isn't in the dataset, is what
    stops a structurally-valid dashboard from rendering empty.

    :param spec: the dashboard spec.
    :param known_columns: ``{dataset_id: [column name, ...]}`` for every
        dataset in scope (see ``mcp_bridge.dataset_columns``).
    :returns: ``{"valid": bool, "errors": [str, ...]}``.
    """
    errors: list = []
    if not _is_obj(spec):
        return {"valid": False, "errors": ["spec must be an object"]}

    data = spec.get("data")
    ref_to_dataset = {}
    if _is_obj(data):
        for key, src in data.items():
            if _is_obj(src) and src.get("kind") == "dataset":
                dataset_id = src.get("id")
                ref_to_dataset[key] = dataset_id
                if _is_str(dataset_id) and dataset_id not in known_columns:
                    errors.append(
                        'spec.data["%s"].id "%s" is not one of the available datasets (%s)'
                        % (key, dataset_id, ", ".join(sorted(known_columns)) or "none"))

    panels = spec.get("panels")
    if _is_obj(panels):
        for key, panel in panels.items():
            if not _is_obj(panel):
                continue
            dataset_id = ref_to_dataset.get(panel.get("dataRef"))
            columns = known_columns.get(dataset_id) if dataset_id else None
            if not columns:
                continue
            measures = panel.get("measures")
            if isinstance(measures, list):
                unknown = [m for m in measures if _is_str(m) and m not in columns]
                if unknown:
                    errors.append(
                        'spec.panels["%s"].measures reference unknown column(s) %s; available: %s'
                        % (key, ", ".join(unknown), ", ".join(columns[:20])))

    return {"valid": not errors, "errors": errors}
