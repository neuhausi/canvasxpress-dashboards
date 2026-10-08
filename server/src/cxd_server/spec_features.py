"""Which building blocks a dashboard spec uses (for the Dashboards list filter chips).

Read-only and computed from the spec at request time, so old and new dashboards
are covered alike and the spec format is untouched.
"""

from __future__ import annotations

from typing import Any, List

# Chip id -> label, in display order. Keep in sync with FEATURE_CHIPS in examples/builder.html.
FEATURES = (
    ("links", "Links"),
    ("fields", "Fields"),
    ("shape", "Shape data"),
    ("filters", "Filters"),
    ("join", "Join"),
    ("function", "Function"),
    ("live", "Live"),
)


def spec_features(spec: Any) -> List[str]:
    """Return the sorted-by-display-order feature ids a spec uses."""
    found = set()
    if not isinstance(spec, dict):
        return []
    if spec.get("relationships"):
        found.add("links")
    data = spec.get("data")
    for source in (data.values() if isinstance(data, dict) else []):
        if not isinstance(source, dict):
            continue
        kind = source.get("kind")
        if kind == "join":
            found.add("join")
            found.add("links")  # every join source implies a relationship
        elif kind in ("function", "live"):
            found.add(kind)
        if source.get("calculatedFields"):
            found.add("fields")
        if source.get("pushdown"):
            found.add("shape")
    panels = spec.get("panels")
    for panel in (panels.values() if isinstance(panels, dict) else []):
        if isinstance(panel, dict) and panel.get("type") == "filters":
            found.add("filters")
    return [key for key, _ in FEATURES if key in found]
