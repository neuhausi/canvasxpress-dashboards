"""canvasxpress-dashboards server: persistence & sharing for dashboard specs."""

__all__ = ["create_dashboards_app", "DashboardStore"]
__version__ = "0.13.0"


def __getattr__(name):
    """Lazily expose the heavy entry points (PEP 562).

    Importing a lightweight submodule — e.g. ``cxd_server.reference_services``,
    which needs only the stdlib — must not pull in the web stack (fastapi). So
    the app factory and the store are resolved only when actually accessed.
    """
    if name == "create_dashboards_app":
        from .app import create_dashboards_app
        return create_dashboards_app
    if name == "DashboardStore":
        from .store import DashboardStore
        return DashboardStore
    raise AttributeError("module %r has no attribute %r" % (__name__, name))
