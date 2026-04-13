# Pull unapplied QBO payments and credit memos into billing.open_credits.
#
# Queries QBO for:
#   1. Payments WHERE UnappliedAmt > '0'
#   2. CreditMemos WHERE RemainingCredit > '0'
# Upserts into billing.open_credits. Removes rows where the QBO entity
# no longer has unapplied balance (credit was applied elsewhere).
#
# Schedule: every 30 minutes.

import requests
import wmill
import psycopg2
import psycopg2.extras
import json
from datetime import datetime, timezone

QBO_RESOURCE = "u/carter/quickbooks_api"
SUPABASE_RESOURCE = "u/carter/supabase"


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


def qbo_query_all(query: str, entity: str, access_token: str, realm_id: str) -> list:
    """Paginated QBO query. Returns all matching entities."""
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    all_results = []
    start = 1
    page_size = 1000

    while True:
        paged = f"{query} STARTPOSITION {start} MAXRESULTS {page_size}"
        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query",
            headers=headers,
            params={"query": paged},
            timeout=30,
        )
        if not resp.ok:
            print(f"  QBO query failed at pos {start}: {resp.status_code}")
            break

        batch = resp.json().get("QueryResponse", {}).get(entity, [])
        all_results.extend(batch)

        if len(batch) < page_size:
            break
        start += page_size

    return all_results


def main():
    """Pull all unapplied payments + credit memos from QBO into billing.open_credits."""
    print("=== pull_qbo_credits started ===")

    access_token, realm_id = refresh_qbo_token()
    conn = get_db_conn()
    now = datetime.now(timezone.utc)

    # ── 1. Fetch unapplied Payments from QBO ─────────────────────
    print("Fetching unapplied payments...")
    payments = qbo_query_all(
        "SELECT * FROM Payment WHERE UnappliedAmt > '0'",
        "Payment", access_token, realm_id
    )
    print(f"  Found {len(payments)} unapplied payments")

    # ── 2. Fetch unapplied CreditMemos from QBO ─────────────────
    print("Fetching unapplied credit memos...")
    credit_memos = qbo_query_all(
        "SELECT * FROM CreditMemo WHERE RemainingCredit > '0'",
        "CreditMemo", access_token, realm_id
    )
    print(f"  Found {len(credit_memos)} unapplied credit memos")

    # ── 3. Build unified list ────────────────────────────────────
    credits = []

    for pmt in payments:
        credits.append({
            "qbo_payment_id": pmt.get("Id"),
            "qbo_customer_id": pmt.get("CustomerRef", {}).get("value"),
            "type": "payment",
            "unapplied_amt": float(pmt.get("UnappliedAmt", 0)),
            "total_amt": float(pmt.get("TotalAmt", 0)),
            "txn_date": pmt.get("TxnDate"),
            "ref_num": pmt.get("PaymentRefNum"),
            "memo": pmt.get("PrivateNote"),
            "raw": pmt,
        })

    for cm in credit_memos:
        credits.append({
            "qbo_payment_id": f"CM-{cm.get('Id')}",  # prefix to avoid ID collision with payments
            "qbo_customer_id": cm.get("CustomerRef", {}).get("value"),
            "type": "credit_memo",
            "unapplied_amt": float(cm.get("RemainingCredit", 0)),
            "total_amt": float(cm.get("TotalAmt", 0)),
            "txn_date": cm.get("TxnDate"),
            "ref_num": cm.get("DocNumber"),
            "memo": cm.get("PrivateNote"),
            "raw": cm,
        })

    print(f"  Total credits to upsert: {len(credits)}")

    # ── 4. Upsert into billing.open_credits ──────────────────────
    cur = conn.cursor()
    upserted = 0

    for c in credits:
        cur.execute("""
            INSERT INTO billing.open_credits
                (qbo_payment_id, qbo_customer_id, type, unapplied_amt,
                 total_amt, txn_date, ref_num, memo, raw, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (qbo_payment_id) DO UPDATE SET
                unapplied_amt = EXCLUDED.unapplied_amt,
                total_amt = EXCLUDED.total_amt,
                txn_date = EXCLUDED.txn_date,
                ref_num = EXCLUDED.ref_num,
                memo = EXCLUDED.memo,
                raw = EXCLUDED.raw,
                fetched_at = EXCLUDED.fetched_at
        """, (
            c["qbo_payment_id"], c["qbo_customer_id"], c["type"],
            c["unapplied_amt"], c["total_amt"], c["txn_date"],
            c["ref_num"], c["memo"],
            psycopg2.extras.Json(c["raw"]),
            now,
        ))
        upserted += 1

    conn.commit()

    # ── 5. Remove stale credits (no longer unapplied in QBO) ─────
    live_ids = [c["qbo_payment_id"] for c in credits]

    if live_ids:
        cur.execute("""
            DELETE FROM billing.open_credits
            WHERE qbo_payment_id != ALL(%s)
            AND fetched_at < %s
        """, (live_ids, now))
    else:
        # No credits at all in QBO — clear everything
        cur.execute("DELETE FROM billing.open_credits WHERE fetched_at < %s", (now,))

    removed = cur.rowcount
    conn.commit()
    cur.close()

    # ── 6. Summary ───────────────────────────────────────────────
    # Count by type
    cur2 = conn.cursor()
    cur2.execute("""
        SELECT type, count(*), sum(unapplied_amt)
        FROM billing.open_credits
        GROUP BY type
    """)
    by_type = {r[0]: {"count": r[1], "total": float(r[2])} for r in cur2.fetchall()}
    cur2.close()
    conn.close()

    total_unapplied = sum(t["total"] for t in by_type.values())

    print(f"=== done: {upserted} upserted, {removed} removed ===")
    print(f"  by type: {by_type}")
    print(f"  total unapplied: ${total_unapplied:,.2f}")

    return {
        "status": "success",
        "upserted": upserted,
        "removed": removed,
        "by_type": by_type,
        "total_unapplied": total_unapplied,
        "qbo_payments_found": len(payments),
        "qbo_credit_memos_found": len(credit_memos),
    }
