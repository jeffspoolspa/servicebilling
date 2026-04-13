# Pull unapplied QBO payments and credit memos into billing.open_credits.
#
# UnappliedAmt is NOT a queryable field in QBO's WHERE clause (computed field).
# So we fetch recent Payments (last 6 months by default) and filter client-side
# for UnappliedAmt > 0. CreditMemos are fewer, so we pull all and filter for
# RemainingCredit > 0.
#
# Upserts into billing.open_credits. Removes rows where the QBO entity no
# longer has unapplied balance (credit was applied elsewhere).
#
# The Postgres trigger fn_on_invoice_number_change reads from this table
# to auto-match credits to work orders when invoice_number is set.
#
# Schedule: every 30 minutes.

import requests
import wmill
import psycopg2
import psycopg2.extras
import json
from datetime import datetime, timezone, timedelta

QBO_RESOURCE = "u/carter/quickbooks_api"
SUPABASE_RESOURCE = "u/carter/supabase"
LOOKBACK_DAYS = 180  # 6 months of payments to scan


def refresh_qbo_token():
    resource = wmill.get_resource(QBO_RESOURCE)
    resp = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": resource["refresh_token"]},
        auth=(resource["client_id"], resource["client_secret"]), timeout=30,
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


def qbo_query_all(query, entity, access_token, realm_id):
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    all_results = []
    start = 1
    while True:
        paged = f"{query} STARTPOSITION {start} MAXRESULTS 1000"
        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query",
            headers=headers, params={"query": paged}, timeout=60,
        )
        if not resp.ok:
            print(f"  QBO query failed at pos {start}: {resp.status_code}")
            break
        batch = resp.json().get("QueryResponse", {}).get(entity, [])
        all_results.extend(batch)
        print(f"  page {(start - 1) // 1000 + 1}: {len(batch)} {entity}s (total {len(all_results)})")
        if len(batch) < 1000:
            break
        start += 1000
    return all_results


def main(lookback_days: int = 180):
    """Pull unapplied payments + credit memos from QBO into billing.open_credits.

    Args:
        lookback_days: How far back to scan for payments (default 6 months).
    """
    print(f"=== pull_qbo_credits started (lookback={lookback_days} days) ===")
    access_token, realm_id = refresh_qbo_token()
    conn = get_db_conn()
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

    # Fetch recent Payments, filter client-side (UnappliedAmt not queryable)
    print(f"Fetching payments since {cutoff}...")
    all_payments = qbo_query_all(
        f"SELECT * FROM Payment WHERE TxnDate >= '{cutoff}'",
        "Payment", access_token, realm_id
    )
    unapplied_payments = [p for p in all_payments if float(p.get("UnappliedAmt", 0)) > 0]
    print(f"  {len(all_payments)} total, {len(unapplied_payments)} with unapplied balance")

    # Fetch all CreditMemos, filter client-side
    print("Fetching credit memos...")
    all_credit_memos = qbo_query_all("SELECT * FROM CreditMemo", "CreditMemo", access_token, realm_id)
    unapplied_cms = [cm for cm in all_credit_memos if float(cm.get("RemainingCredit", 0)) > 0]
    print(f"  {len(all_credit_memos)} total, {len(unapplied_cms)} with remaining credit")

    # Build unified list
    credits = []
    for pmt in unapplied_payments:
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
    for cm in unapplied_cms:
        credits.append({
            "qbo_payment_id": f"CM-{cm.get('Id')}",
            "qbo_customer_id": cm.get("CustomerRef", {}).get("value"),
            "type": "credit_memo",
            "unapplied_amt": float(cm.get("RemainingCredit", 0)),
            "total_amt": float(cm.get("TotalAmt", 0)),
            "txn_date": cm.get("TxnDate"),
            "ref_num": cm.get("DocNumber"),
            "memo": cm.get("PrivateNote"),
            "raw": cm,
        })

    print(f"Total to upsert: {len(credits)}")

    # Upsert
    cur = conn.cursor()
    upserted = 0
    for c in credits:
        cur.execute("""
            INSERT INTO billing.open_credits
                (qbo_payment_id, qbo_customer_id, type, unapplied_amt,
                 total_amt, txn_date, ref_num, memo, raw, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (qbo_payment_id) DO UPDATE SET
                unapplied_amt = EXCLUDED.unapplied_amt, total_amt = EXCLUDED.total_amt,
                txn_date = EXCLUDED.txn_date, ref_num = EXCLUDED.ref_num,
                memo = EXCLUDED.memo, raw = EXCLUDED.raw, fetched_at = EXCLUDED.fetched_at
        """, (
            c["qbo_payment_id"], c["qbo_customer_id"], c["type"],
            c["unapplied_amt"], c["total_amt"], c["txn_date"],
            c["ref_num"], c["memo"], psycopg2.extras.Json(c["raw"]), now,
        ))
        upserted += 1
    conn.commit()

    # Remove stale
    live_ids = [c["qbo_payment_id"] for c in credits]
    if live_ids:
        cur.execute("DELETE FROM billing.open_credits WHERE qbo_payment_id != ALL(%s)", (live_ids,))
    else:
        cur.execute("DELETE FROM billing.open_credits")
    removed = cur.rowcount
    conn.commit()

    # Summary
    cur.execute("SELECT type, count(*), sum(unapplied_amt) FROM billing.open_credits GROUP BY type")
    by_type = {r[0]: {"count": r[1], "total": float(r[2])} for r in cur.fetchall()}
    cur.execute("SELECT count(*) FROM billing.open_credits WHERE ref_num IS NOT NULL AND ref_num ~ '^\\d{5,}$'")
    wo_tagged = cur.fetchone()[0]
    cur.close()
    conn.close()

    total_unapplied = sum(t["total"] for t in by_type.values())
    print(f"=== done: {upserted} upserted, {removed} removed ===")
    print(f"  by type: {by_type}")
    print(f"  WO-tagged: {wo_tagged}")
    print(f"  total: ${total_unapplied:,.2f}")

    return {
        "status": "success", "upserted": upserted, "removed": removed,
        "by_type": by_type, "wo_tagged_credits": wo_tagged,
        "total_unapplied": total_unapplied,
        "qbo_payments_scanned": len(all_payments),
        "qbo_payments_unapplied": len(unapplied_payments),
        "qbo_credit_memos_unapplied": len(unapplied_cms),
    }
