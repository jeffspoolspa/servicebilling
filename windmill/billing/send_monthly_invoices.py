# Mirrored from Windmill: f/billing/send_monthly_invoices
# Hash: 47dbf0634d43a3f8
# Last pulled: 2026-04-07
# Summary: Send monthly maintenance invoices via QBO email delivery with pre-send safety checks
# Description: Sends pending maintenance invoices via QBO email API. Source of truth is
#   send_status='pending' on maintenance_invoices. Four pre-send safety checks: no-email,
#   send log dedup, live QBO balance, and QBO EmailStatus dedup (prevents re-sending invoices
#   already emailed from QBO). Logs results to invoice_send_log and updates send_status.

import requests
import wmill
import psycopg2
import psycopg2.extras
import time


def refresh_qbo_tokens(resource_path: str) -> tuple:
    """Refresh QBO tokens and SAVE new refresh token. Returns (access_token, realm_id)."""
    resource = wmill.get_resource(resource_path)
    resp = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": resource["refresh_token"]},
        auth=(resource["client_id"], resource["client_secret"]),
    )
    if not resp.ok:
        raise Exception(f"QBO token refresh failed: {resp.status_code} - {resp.text}")
    tokens = resp.json()
    resource["refresh_token"] = tokens["refresh_token"]
    wmill.set_resource(resource_path, resource)
    return tokens["access_token"], resource["realm_id"]


def get_qbo_invoice_details(invoice_id: str, realm_id: str, access_token: str):
    """Fetch live balance and EmailStatus from QBO."""
    try:
        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/invoice/{invoice_id}?minorversion=65",
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        if not resp.ok:
            return None
        inv = resp.json().get("Invoice", {})
        return {
            "balance": float(inv.get("Balance", -1)),
            "email_status": inv.get("EmailStatus"),
        }
    except Exception:
        return None


def send_qbo_invoice_email(invoice_id: str, email: str, realm_id: str, access_token: str) -> tuple:
    """Send invoice via QBO email API. Returns (success: bool, error_msg: str|None)."""
    try:
        resp = requests.post(
            f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/invoice/{invoice_id}/send?sendTo={requests.utils.quote(email)}",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "Content-Type": "application/octet-stream",
            },
        )
        if resp.ok:
            return True, None
        return False, f"QBO {resp.status_code}: {resp.text[:300]}"
    except Exception as e:
        return False, str(e)


def main(
    billing_month: str = "2026-02",
    dry_run: bool = True,
    batch_delay_ms: int = 350,
):
    access_token, realm_id = refresh_qbo_tokens("u/carter/quickbooks_api")

    pg = wmill.get_resource("u/carter/supabase")
    conn = psycopg2.connect(
        host=pg["host"], port=pg["port"], dbname=pg["dbname"],
        user=pg["user"], password=pg["password"], sslmode="require",
    )
    conn.autocommit = True
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    billing_date = f"{billing_month}-01"

    try:
        cur.execute(
            """
            SELECT mi.id, mi.qbo_invoice_id, mi.qbo_customer_id, mi.customer_name,
                   mi.invoice_total, mi.balance_due, c.email
            FROM billing_audit.maintenance_invoices mi
            LEFT JOIN public."Customers" c ON c.qbo_customer_id = mi.qbo_customer_id
            WHERE mi.billing_month = %s AND mi.send_status = 'pending'
            ORDER BY mi.customer_name
            """,
            (billing_date,),
        )
        invoices = cur.fetchall()
        print(f"{len(invoices)} invoices in pending state for {billing_month}")

        if dry_run:
            return {
                "dry_run": True, "billing_month": billing_month,
                "would_send": len(invoices),
            }

        results = {
            "sent": 0, "skipped_already_sent": 0, "skipped_already_emailed_qbo": 0,
            "skipped_already_paid": 0, "skipped_balance_check_failed": 0,
            "skipped_no_email": 0, "failed": 0, "errors": [],
        }

        for inv in invoices:
            # Pre-send checks A-D omitted for mirror brevity. See Windmill UI for full flow:
            #  A) email exists
            #  B) not already in send log
            #  C) live QBO balance > 0 (not paid since)
            #  D) QBO EmailStatus != "EmailSent"
            # Then send_qbo_invoice_email() and write log.
            time.sleep(batch_delay_ms / 1000.0)

        return {"billing_month": billing_month, "this_run": results}

    finally:
        cur.close()
        conn.close()
