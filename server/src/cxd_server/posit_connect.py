"""Sign-in delegated to Posit Connect.

When the app is deployed as Posit Connect content, Connect has already
authenticated the visitor before the request reaches the app, and it passes the
result along in the ``RStudio-Connect-Credentials`` header as JSON:
``{"user": "<username>", "groups": ["<group>", ...]}``. With
``CXD_POSIT_CONNECT_AUTH=on`` the app trusts that header and signs the visitor in
as that user, creating the local account on first visit, so there is no second
login.

Only turn this on behind Connect: anywhere else the header is just a value the
client chose to send.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Optional

HEADER = "rstudio-connect-credentials"
ISSUER = "posit-connect"


def connect_user(headers: Mapping[str, Any]) -> Optional[str]:
    """The username Connect vouches for, or None (no header, or not usable)."""
    raw = headers.get(HEADER)
    if not raw:
        return None
    try:
        creds = json.loads(raw)
    except ValueError:
        return None
    user = creds.get("user") if isinstance(creds, dict) else None
    return user.strip() if isinstance(user, str) and user.strip() else None
