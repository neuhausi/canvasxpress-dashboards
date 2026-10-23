"""canvasxpress-dashboards for Python: linked, multi-panel CanvasXpress dashboards in Jupyter, Dash,
Streamlit and Flask. Render a spec, or build a whole dashboard from a DataFrame::

    from canvasxpress_dashboards import Dashboard
    Dashboard(data=trial, id="patient")         # a cohort (or run-QC) table -> a linked dashboard
    Dashboard("my-dashboard.spec.json")         # or a spec you wrote
"""

from .data import cxd_data
from .spec import read_spec
from .widget import Dashboard, dashboard, ENGINE_URL

__version__ = "0.1.1"
__all__ = ["Dashboard", "dashboard", "cxd_data", "read_spec", "ENGINE_URL", "__version__"]
