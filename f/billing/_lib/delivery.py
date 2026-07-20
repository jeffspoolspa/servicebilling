# requirements:
# psycopg2-binary
# requests
# wmill

"""
f/billing/_lib/delivery — the shared document-delivery service.

Emailing a customer their invoice copy or receipt is a DELIVERY action, not a
payment (payments = moving money, in _lib/payments). This module is the single,
idempotent gate for getting a QBO document to the customer, shared by every
workflow that sends: the maintenance charge worker (auto), the manual Send
action, and service billing. One shared gate is what makes a double-send
structurally impossible.

Layer: service (composes the _lib/qbo send primitive + the _lib/cache echo).

Import as:  from f.billing._lib.delivery import deliver_invoice
"""

from f.billing._lib.qbo import send_invoice
from f.billing._lib.cache import mark_emailed


def deliver_invoice(conn, invoice_id, email, email_status,
                    access_token, realm_id, resend=False):
    """Email the customer their invoice copy, idempotently, and record the
    emailed fact. Skips if the invoice is already `EmailSent` (unless
    `resend=True` — the manual "Send invoice copies" path). On success records
    the emailed fact (mark_emailed echo). Returns {ok, error?, already?}.
    """
    if not resend and email_status == "EmailSent":
        return {"ok": True, "already": True}
    if not email:
        return {"ok": False, "error": "no email on file"}
    r = send_invoice(invoice_id, email, access_token, realm_id)
    if r.get("ok"):
        mark_emailed(conn, invoice_id)
    return r


def _selfcheck():
    """No network/DB — verify the idempotency guards only."""
    calls = {"sent": 0, "marked": 0}
    g = globals()
    real_send, real_mark = g["send_invoice"], g["mark_emailed"]

    def fake_send(inv, email, at, realm):
        calls["sent"] += 1
        return {"ok": True, "error": None}

    def fake_mark(conn, inv):
        calls["marked"] += 1

    g["send_invoice"], g["mark_emailed"] = fake_send, fake_mark
    try:
        # already EmailSent, not a resend -> skip (no send)
        r = deliver_invoice(None, "i1", "a@b.com", "EmailSent", "t", "r")
        assert r == {"ok": True, "already": True} and calls["sent"] == 0
        # resend bypasses the guard -> sends + records
        r = deliver_invoice(None, "i1", "a@b.com", "EmailSent", "t", "r", resend=True)
        assert r["ok"] and calls["sent"] == 1 and calls["marked"] == 1
        # no email -> no send
        r = deliver_invoice(None, "i1", None, "NotSet", "t", "r")
        assert r["ok"] is False and calls["sent"] == 1
        # fresh invoice -> sends + records
        r = deliver_invoice(None, "i2", "a@b.com", "NotSet", "t", "r")
        assert r["ok"] and calls["sent"] == 2 and calls["marked"] == 2
    finally:
        g["send_invoice"], g["mark_emailed"] = real_send, real_mark
    return "ok"


def main():
    return {"selfcheck": _selfcheck()}
