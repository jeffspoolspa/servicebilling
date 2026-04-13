# Pull QBO invoices into billing.invoices cache.
#
# For every work_orders.invoice_number that isn't yet in billing.invoices (or
# is stale beyond max_age_minutes), batch-query QBO via IN-clause for the full
# Invoice records and upsert them into billing.invoices.
#
# The QBO Invoice API returns the Line[] array in the same response, so we
# extract it into billing.invoices.line_items (jsonb) for free — no extra API
# calls per invoice.
#
# Pattern reference: f/service_billing/distinguished_script (servicebilling_check_status)
# uses the same IN-clause batching for the much cheaper status-only query.

import requests
import wmill
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone, timedelta

QBO_RESOURCE = "u/carter/quickbooks_api"
SUPABASE_RESOURCE = "u/carter/supabase"
QBO_IN_BATCH_SIZE = 200  # Smaller than check_status's 400 because SELECT * is heavier
DEFAULT_MAX_AGE_MINUTES = 60  # Re-fetch invoices older than this when not force_refresh


def refresh_qbo_token():
    resource = wmill.get_resource(QBO_RESOURCE)
    resp = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": resource["refresh_token"],
        },
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
        host=sb["host"],
        port=sb.get("port", 6543),
        dbname=sb.get("dbname", "postgres"),
        user=sb["user"],
        password=sb["password"],
        sslmode=sb.get("sslmode", "require"),
    )


def find_invoice_numbers_to_fetch(
    conn, force_refresh: bool, max_age_minutes: int, limit: int | None
) -> list[str]:
    """Find distinct invoice_numbers from work_orders that need fetching.

    Returns invoice numbers that are either:
    - Not in billing.invoices at all, OR
    - In billing.invoices but fetched_at is older than max_age_minutes (and not force_refresh)
    - All of them, if force_refresh is True
    """
    cur = conn.cursor()
    if force_refresh:
        sql = """
            SELECT DISTINCT w.invoice_number
            FROM public.work_orders w
            WHERE w.invoice_number IS NOT NULL
              AND w.billing_status != 'not_billable'
        """
    else:
        sql = """
            SELECT DISTINCT w.invoice_number
            FROM public.work_orders w
            LEFT JOIN billing.invoices i ON i.doc_number = w.invoice_number
            WHERE w.invoice_number IS NOT NULL
              AND w.billing_status != 'not_billable'
              AND (
                i.qbo_invoice_id IS NULL
                OR i.fetched_at < (now() - (%s || ' minutes')::interval)
              )
        """
    params = [str(max_age_minutes)] if not force_refresh else []
    if limit:
        sql += " LIMIT %s"
        params.append(limit)

    cur.execute(sql, params if params else None)
    rows = [r[0] for r in cur.fetchall()]
    cur.close()
    return rows


def batch_fetch_invoices(
    invoice_numbers: list[str], access_token: str, realm_id: str
) -> tuple[dict, list[str]]:
    """Query QBO for full Invoice records via IN-clause batches.

    Returns ({doc_number: Invoice}, [errors])
    """
    if not invoice_numbers:
        return {}, []

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    found = {}
    errors = []

    for i in range(0, len(invoice_numbers), QBO_IN_BATCH_SIZE):
        batch = invoice_numbers[i : i + QBO_IN_BATCH_SIZE]
        in_values = ", ".join([f"'{d}'" for d in batch])
        query = (
            f"SELECT * FROM Invoice WHERE DocNumber IN ({in_values}) MAXRESULTS 1000"
        )

        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query?minorversion=65",
            headers=headers,
            params={"query": query},
            timeout=60,
        )

        if not resp.ok:
            err = f"Batch {i // QBO_IN_BATCH_SIZE + 1}: HTTP {resp.status_code} - {resp.text[:300]}"
            print(f"  ERROR: {err}")
            errors.append(err)
            continue

        invoices = resp.json().get("QueryResponse", {}).get("Invoice", [])
        for inv in invoices:
            doc_num = inv.get("DocNumber")
            if doc_num:
                found[str(doc_num)] = inv

        print(
            f"  batch {i // QBO_IN_BATCH_SIZE + 1}: requested {len(batch)}, returned {len(invoices)}"
        )

    return found, errors


def transform_line_items(qbo_lines: list[dict]) -> list[dict]:
    """Transform QBO Line[] into our line_items jsonb shape.

    Each line item:
      { item_id, item_name, description, qty, unit_price, amount, line_type }
    """
    out = []
    for line in qbo_lines:
        if line.get("DetailType") not in (
            "SalesItemLineDetail",
            "DescriptionOnly",
            "SubTotalLineDetail",
            "DiscountLineDetail",
        ):
            continue

        amount = float(line.get("Amount", 0) or 0)
        desc = line.get("Description", "")
        line_type = "item"

        if line.get("DetailType") == "SubTotalLineDetail":
            line_type = "subtotal"
            out.append({
                "item_id": None,
                "item_name": "Subtotal",
                "description": desc,
                "qty": None,
                "unit_price": None,
                "amount": amount,
                "line_type": line_type,
            })
            continue

        if line.get("DetailType") == "DescriptionOnly":
            out.append({
                "item_id": None,
                "item_name": None,
                "description": desc,
                "qty": None,
                "unit_price": None,
                "amount": amount,
                "line_type": "description",
            })
            continue

        if line.get("DetailType") == "DiscountLineDetail":
            d = line.get("DiscountLineDetail", {}) or {}
            out.append({
                "item_id": None,
                "item_name": "Discount",
                "description": desc,
                "qty": None,
                "unit_price": None,
                "amount": amount,
                "line_type": "discount",
                "percent": d.get("DiscountPercent"),
            })
            continue

        si = line.get("SalesItemLineDetail", {}) or {}
        item_ref = si.get("ItemRef", {}) or {}
        out.append({
            "item_id": item_ref.get("value"),
            "item_name": item_ref.get("name"),
            "description": desc,
            "qty": float(si.get("Qty", 0) or 0),
            "unit_price": float(si.get("UnitPrice", 0) or 0),
            "amount": amount,
            "line_type": "item",
        })

    return out


def upsert_invoices(conn, qbo_invoices: dict) -> int:
    """Upsert each QBO invoice into billing.invoices, including line_items jsonb."""
    if not qbo_invoices:
        return 0

    cur = conn.cursor()
    upserted = 0
    now = datetime.now(timezone.utc)

    for doc_number, inv in qbo_invoices.items():
        try:
            qbo_id = inv.get("Id")
            customer_ref = inv.get("CustomerRef", {}) or {}
            line_items = transform_line_items(inv.get("Line", []))

            cur.execute(
                """
                INSERT INTO billing.invoices (
                    qbo_invoice_id, doc_number, qbo_customer_id, customer_name,
                    txn_date, due_date, total_amt, subtotal, balance, email_status,
                    line_items, raw, fetched_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s
                )
                ON CONFLICT (qbo_invoice_id) DO UPDATE SET
                    doc_number = EXCLUDED.doc_number,
                    qbo_customer_id = EXCLUDED.qbo_customer_id,
                    customer_name = EXCLUDED.customer_name,
                    txn_date = EXCLUDED.txn_date,
                    due_date = EXCLUDED.due_date,
                    total_amt = EXCLUDED.total_amt,
                    subtotal = EXCLUDED.subtotal,
                    balance = EXCLUDED.balance,
                    email_status = EXCLUDED.email_status,
                    line_items = EXCLUDED.line_items,
                    raw = EXCLUDED.raw,
                    fetched_at = EXCLUDED.fetched_at
                """,
                (
                    qbo_id,
                    str(doc_number),
                    customer_ref.get("value"),
                    customer_ref.get("name"),
                    inv.get("TxnDate"),
                    inv.get("DueDate"),
                    float(inv.get("TotalAmt", 0) or 0),
                    float(inv.get("Subtotal") or inv.get("TotalAmt", 0) or 0),
                    float(inv.get("Balance", 0) or 0),
                    inv.get("EmailStatus"),
                    psycopg2.extras.Json(line_items),
                    psycopg2.extras.Json(inv),
                    now,
                ),
            )
            upserted += 1
        except Exception as e:
            print(f"  upsert error for doc {doc_number}: {e}")

    conn.commit()
    cur.close()
    return upserted


def main(
    force_refresh: bool = False,
    max_age_minutes: int = 60,
    limit: int | None = None,
):
    """Pull QBO invoices into billing.invoices cache.

    Args:
        force_refresh: Re-fetch every billable WO's invoice regardless of cache.
        max_age_minutes: Skip invoices in billing.invoices fetched more recently than this.
        limit: Hard cap on number of invoice_numbers to fetch (for testing/dry-run).
    """
    print(f"=== pull_qbo_invoices started ===")
    print(f"force_refresh={force_refresh} max_age_minutes={max_age_minutes} limit={limit}")

    conn = get_db_conn()
    try:
        # 1. Discover what to fetch
        invoice_numbers = find_invoice_numbers_to_fetch(
            conn, force_refresh, max_age_minutes, limit
        )
        print(f"Found {len(invoice_numbers)} invoice numbers to fetch")

        if not invoice_numbers:
            return {
                "status": "nothing_to_fetch",
                "to_fetch": 0,
                "fetched": 0,
                "upserted": 0,
            }

        # 2. Auth + batched QBO query
        access_token, realm_id = refresh_qbo_token()
        qbo_invoices, errors = batch_fetch_invoices(
            invoice_numbers, access_token, realm_id
        )
        print(f"QBO returned {len(qbo_invoices)} invoices ({len(errors)} batch errors)")

        not_found = [n for n in invoice_numbers if str(n) not in qbo_invoices]
        if not_found:
            print(f"  not found in QBO: {len(not_found)} (first 10: {not_found[:10]})")

        # 3. Upsert into billing.invoices
        upserted = upsert_invoices(conn, qbo_invoices)
        print(f"Upserted {upserted} invoices into billing.invoices")

        # 4. Re-evaluate stuck WOs: any needs_classification WO that now has
        #    a cached invoice should re-trigger classification. We "touch" the
        #    row by setting invoice_number = invoice_number. The trigger's guard
        #    (billing_status IN ('not_billable','needs_classification')) lets it
        #    through and classification succeeds now that the invoice is cached.
        cur = conn.cursor()
        cur.execute("""
            UPDATE public.work_orders
            SET invoice_number = invoice_number
            WHERE billing_status = 'needs_classification'
              AND invoice_number IN (SELECT doc_number FROM billing.invoices)
        """)
        reclassified = cur.rowcount
        conn.commit()
        cur.close()
        if reclassified > 0:
            print(f"Re-triggered classification for {reclassified} stuck WOs")

        return {
            "status": "success" if not errors else "partial",
            "to_fetch": len(invoice_numbers),
            "fetched": len(qbo_invoices),
            "upserted": upserted,
            "reclassified": reclassified,
            "not_found_in_qbo": len(not_found),
            "not_found_sample": not_found[:20],
            "batch_errors": errors,
        }
    finally:
        conn.close()
