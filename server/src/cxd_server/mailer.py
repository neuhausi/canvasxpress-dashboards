"""Outgoing email for alerts and dashboard subscriptions.

Configured with environment variables (all optional; email is off without a host):

``CXD_SMTP_HOST``, ``CXD_SMTP_PORT`` (587), ``CXD_SMTP_USER``, ``CXD_SMTP_PASSWORD`` (or
``CXD_SMTP_PASSWORD_FILE``, a file holding it),
``CXD_SMTP_FROM`` (defaults to the user), and ``CXD_SMTP_SECURITY``: ``starttls``
(default), ``ssl`` or ``none``.
"""

from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import make_msgid
from typing import List, Optional, Sequence, Tuple

# (filename, bytes, mime type, inline content id or None)
Attachment = Tuple[str, bytes, str, Optional[str]]


class MailError(RuntimeError):
    """Sending failed (the message says why)."""


def build_message(sender: str, to: str, subject: str, text: str, html: Optional[str] = None,
                  attachments: Sequence[Attachment] = ()) -> EmailMessage:
    """A multipart message: plain text, optional HTML, attachments (inline when
    they carry a content id, referenced from the HTML as ``cid:<id>``)."""
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[-1] if "@" in sender else None)
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
        html_part = msg.get_payload()[-1]
        for filename, data, mime, cid in attachments:
            if cid:
                maintype, subtype = mime.split("/", 1)
                html_part.add_related(data, maintype=maintype, subtype=subtype,
                                      cid="<%s>" % cid, filename=filename)
    for filename, data, mime, cid in attachments:
        if not (html and cid):
            maintype, subtype = mime.split("/", 1)
            msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return msg


class SmtpMailer:
    """Sends each message with ``smtplib`` (one connection per batch)."""

    enabled = True

    def __init__(self, host: str, port: int = 587, user: Optional[str] = None,
                 password: Optional[str] = None, sender: Optional[str] = None,
                 security: str = "starttls", timeout: float = 30.0):
        self.host, self.port = host, int(port)
        self.user, self.password = user, password
        self.sender = sender or user or "cxd@localhost"
        self.security = (security or "starttls").lower()
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> Optional["SmtpMailer"]:
        host = os.getenv("CXD_SMTP_HOST")
        if not host:
            return None
        password = os.getenv("CXD_SMTP_PASSWORD") or None
        password_file = os.getenv("CXD_SMTP_PASSWORD_FILE")
        if not password and password_file:
            # Keeps the secret out of .env (e.g. an app password in a chmod-600 file).
            with open(os.path.expanduser(password_file), encoding="utf-8") as fh:
                password = fh.read().strip() or None
        return cls(host, int(os.getenv("CXD_SMTP_PORT", "587") or 587),
                   os.getenv("CXD_SMTP_USER") or None, password,
                   os.getenv("CXD_SMTP_FROM") or None, os.getenv("CXD_SMTP_SECURITY", "starttls"))

    def send(self, messages: List[Tuple[str, str, str, Optional[str],
                                        Sequence[Attachment]]]) -> int:
        """Send ``(to, subject, text, html, attachments)`` messages; returns how many went."""
        if not messages:
            return 0
        try:
            if self.security == "ssl":
                server = smtplib.SMTP_SSL(self.host, self.port, timeout=self.timeout,
                                          context=ssl.create_default_context())
            else:
                server = smtplib.SMTP(self.host, self.port, timeout=self.timeout)
            with server:
                if self.security == "starttls":
                    server.starttls(context=ssl.create_default_context())
                if self.user:
                    server.login(self.user, self.password or "")
                for to, subject, text, html, attachments in messages:
                    server.send_message(build_message(self.sender, to, subject, text, html,
                                                      attachments))
        except (smtplib.SMTPException, OSError) as exc:
            raise MailError("%s: %s" % (type(exc).__name__, exc))
        return len(messages)


class MemoryMailer:
    """Keeps messages in a list instead of sending them (tests, dry runs)."""

    enabled = True
    sender = "cxd@example.test"

    def __init__(self):
        self.sent: List[EmailMessage] = []

    def send(self, messages) -> int:
        for to, subject, text, html, attachments in messages:
            self.sent.append(build_message(self.sender, to, subject, text, html, attachments))
        return len(messages)
