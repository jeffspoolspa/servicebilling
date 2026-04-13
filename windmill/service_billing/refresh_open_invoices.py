# Refresh billing.invoices cache for open invoices only.
#
# Queries billing.invoices WHERE balance > 0, batches the doc_numbers
# into IN-clause QBO queries, and updates balance + email_status.
# Paid invoices (balance = 0) are skipped — they're done.
#
# Also handles auto-transition: if a ready_to_process WO's invoice is
# now balance=0 + EmailSent, transition to 'processed' automatically.
#
# Schedule: every 4 hours.

import requests
import wmill
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone

QBO_RESOURCE = "u/carter/quickbooks_api"
SUPABASE_RESOURCE = "u/carter/supabase"
QBO_IN_BATCH_SIZE = 400


def refresh_qbo_token():
    resource = wmill.get_resource(QBO_RESOURCE)
    resp = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": resource["refresh_token"]},
        auth=(resource["client_id"], resource["client_secret"]),
        timeout=30,
    )
    if not resp.ok:
        raise Exception(f"QBO token refresh failed: {resp.status_code} - {resp.text}")
    tokens = resp.json()
    resource["refresh_token"] = tokens["refresh_token"]
    wmill.set_resource(QBO_RESOURCE, resource)
    return tokens["access_token"], resource["realm_id"]


def get_db_conn():
    sb = wmill.get_resource(SUPABASE_RESOURCE)
    return psycopg2.connect(
        host=sb["host"], port=sb.get("port", 6543),
        dbname=sb.get("dbname", "postgres"), user=sb["user"],
        password=sb["password"], sslmode=sb.get("sslmode", "require"),
    )


def main():
    """Refresh balance + email_status for open invoices only."""
    print("=== refresh_open_invoices started ===")

    conn = get_db_conn()
    cur = conn.cursor()

    # 1. Find open invoices to refresh
    cur.execute("""
        SELECT doc_number FROM billing.invoices
        WHERE balance > 0 OR balance IS NULL
    """)
    doc_numbers = [r[0] for r in cur.fetchall()]
    print(f"Found {len(doc_numbers)} open invoices to refresh")

    if not doc_numbers:
        cur.close()
        conn.close()
        return {"status": "nothing_to_refresh", "open_invoices": 0}

    # 2. Batch query QBO
    access_token, realm_id = refresh_qbo_token()
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    qbo_data = {}  # doc_number → {balance, email_status}

    for i in range(0, len(doc_numbers), QBO_IN_BATCH_SIZE):
        batch = doc_numbers[i:i + QBO_IN_BATCH_SIZE]
        in_values = ", ".join([f"'{d}'" for d in batch])
        query = f"SELECT DocNumber, Balance, EmailStatus FROM Invoice WHERE DocNumber IN ({in_values}) MAXRESULTS 1000"

        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query",
            headers=headers,
            params={"query": query},
            timeout=30,
        )

        if resp.ok:
            for inv in resp.json().get("QueryResponse", {}).get("Invoice", []):
                doc_num = inv.get("DocNumber")
                if doc_num:
                    qbo_data[str(doc_num)] = {
                        "balance": float(inv.get("Balance", 0)),
                        "email_status": inv.get("EmailStatus"),
                    }
            print(f"  batch {i // QBO_IN_BATCH_SIZE + 1}: queried {len(batch)}, returned {len(qbo_data)}")
        else:
            print(f"  batch {i // QBO_IN_BATCH_SIZE + 1} failed: {resp.status_code}")

    # 3. Update billing.invoices cache
    now = datetime.now(timezone.utc)
    updated = 0
    newly_paid = 0

    for doc_number in doc_numbers:
        if doc_number in qbo_data:
            d = qbo_data[doc_number]
            cur.execute("""
                UPDATE billing.invoices
                SET balance = %s, email_status = %s, fetched_at = %s
                WHERE doc_number = %s
            """, (d["balance"], d["email_status"], now, doc_number))
            updated += 1
            if d["balance"] == 0:
                newly_paid += 1
        else:
            # Not found in QBO open query — might be voided or deleted
            cur.execute("""
                UPDATE billing.invoices
                SET balance = 0, fetched_at = %s
                WHERE doc_number = %s
            """, (now, doc_number))
            updated += 1
            newly_paid += 1

    conn.commit()

    # 4. Auto-transition: ready_to_process → processed if invoice is paid + sent
    cur.execute("""
        UPDATE public.work_orders w
        SET billing_status = 'processed', billing_status_set_at = now()
        FROM billing.invoices i
        WHERE i.doc_number = w.invoice_number
          AND w.billing_status = 'ready_to_process'
          AND i.balance = 0
          AND i.email_status = 'EmailSent'
    """)
    auto_transitioned = cur.rowcount
    conn.commit()

    cur.close()
    conn.close()

    print(f"=== done: {updated} refreshed, {newly_paid} newly paid, {auto_transitioned} auto-transitioned ===")

    return {
        "status": "success",
        "open_invoices_checked": len(doc_numbers),
        "qbo_returned": len(qbo_data),
        "updated": updated,
        "newly_paid": newly_paid,
        "auto_transitioned_to_processed": auto_transitioned,
    }
