"""Live data services for the reference-database dashboards.

This is now a thin re-export of the packaged :mod:`cxd_server.reference_services`
so the dev launcher (``serve.py``), the standalone ``db-adapter.py`` and the
packaged server never drift (it used to be a full copy). The package submodule
needs only the stdlib, and ``cxd_server``'s package init is lazy, so importing it
here does not pull in the web stack.
"""

import os
import sys

# Work even when the package is not pip-installed (e.g. a bare standalone
# db-adapter run): add the repo's server/src so ``cxd_server`` resolves.
_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server", "src")
if os.path.isdir(_SRC) and _SRC not in sys.path:
    sys.path.insert(0, _SRC)

from cxd_server.reference_services import (  # noqa: E402,F401 - re-exported API
    LABEL,
    REFERENCE_DBS,
    SQLITE_DIR,
    db_path,
    db_present,
    handle,
)
