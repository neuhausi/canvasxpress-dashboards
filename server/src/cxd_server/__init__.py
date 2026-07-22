"""canvasxpress-dashboards server: persistence & sharing for dashboard specs."""

from .app import create_dashboards_app
from .store import DashboardStore

__all__ = ["create_dashboards_app", "DashboardStore"]
__version__ = "0.3.0"
