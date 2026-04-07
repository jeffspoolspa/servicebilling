# Mirrored from Windmill: f/qbo/qbo_customer_sync
# Hash: 3d920bf24ad6efd5
# Last pulled: 2026-04-07
# Summary: QBO Customer Sync with billing + service addresses (Line2 fix)
# Description: Syncs all QBO customers to Supabase daily. Pulls both BillAddr and ShipAddr.
#   Uses Line2 when Line1 contains customer name. Soft deletes for removed customers.
#
# This script is the canonical pattern for QBO → Supabase syncs in this codebase. The
# service-billing module's pull_qbo_invoices job follows the same shape:
#   - Token refresh with refresh-token rotation
#   - Paginated fetch from QBO
#   - Bulk upsert via executemany ON CONFLICT
#   - Soft-delete for removed records
#   - Sync log entry
#   - Retry with backoff on 429s
#   - Step-tagged error reporting

import requests
import psycopg2
import wmill
import time
import re
from datetime import datetime, timezone


QBO_RESOURCE = "u/carter/quickbooks_api"
SUPABASE_RESOURCE = "u/carter/supabase"
MAX_RETRIES = 3
REQUEST_TIMEOUT = 30


def get_pg_connection():
    supabase = wmill.get_resource(SUPABASE_RESOURCE)
    return psycopg2.connect(
        host=supabase["host"], port=supabase["port"],
        dbname=supabase["dbname"], user=supabase["user"],
        password=supabase["password"], connect_timeout=10
    )


def create_sync_log(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("INSERT INTO qbo_customer_sync_log (status) VALUES ('running') RETURNING id")
        log_id = cur.fetchone()[0]
        conn.commit()
    return log_id


def update_sync_log(conn, log_id, status, records_synced=None, records_deleted=None,
                    active_count=None, inactive_count=None, error_message=None, error_step=None):
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE qbo_customer_sync_log SET completed_at = NOW(), status = %s,
                records_synced = %s, records_deleted = %s, active_count = %s,
                inactive_count = %s, error_message = %s, error_step = %s
            WHERE id = %s
        """, (status, records_synced, records_deleted, active_count,
              inactive_count, error_message, error_step, log_id))
        conn.commit()


def refresh_qbo_token():
    resource = wmill.get_resource(QBO_RESOURCE)
    response = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": resource["refresh_token"]},
        auth=(resource["client_id"], resource["client_secret"]), timeout=REQUEST_TIMEOUT
    )
    if response.status_code == 401:
        raise Exception("QBO refresh token burned — manual reauth required")
    if not response.ok:
        raise Exception(f"QBO token refresh failed: HTTP {response.status_code}")

    tokens = response.json()
    resource["refresh_token"] = tokens["refresh_token"]
    wmill.set_resource(QBO_RESOURCE, resource)
    return tokens["access_token"], resource["realm_id"]


def qbo_query(access_token, realm_id, query):
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.get(
                f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query",
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
                params={"query": query}, timeout=REQUEST_TIMEOUT
            )
            if response.status_code == 401:
                raise Exception("QBO API 401 - token expired mid-sync")
            if response.status_code == 429:
                time.sleep(2 ** (attempt + 2))
                continue
            if not response.ok:
                raise Exception(f"QBO API: HTTP {response.status_code}")
            return response.json()
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            last_error = str(e)
        if attempt < MAX_RETRIES - 1:
            time.sleep(2 ** attempt)
    raise Exception(f"QBO query failed after {MAX_RETRIES} attempts: {last_error}")


def fetch_all_customers(access_token, realm_id):
    all_customers = []
    start = 1
    while True:
        result = qbo_query(access_token, realm_id,
                           f"SELECT * FROM Customer STARTPOSITION {start} MAXRESULTS 1000")
        customers = result.get('QueryResponse', {}).get('Customer', [])
        if not customers:
            break
        all_customers.extend(customers)
        if len(customers) < 1000:
            break
        start += 1000
    return all_customers


def extract_street(addr):
    """Extract the actual street from a QBO address block.
    QBO often puts the customer name in Line1 and the street in Line2."""
    if not addr:
        return None
    line1 = (addr.get("Line1") or "").strip()
    line2 = (addr.get("Line2") or "").strip()
    if line2:
        if re.match(r'^\d', line2):
            return line2
        if re.match(r'^\d', line1):
            return line1
        return line2
    return line1 if line1 else None


def sync_customers_to_supabase(conn, customers):
    stats = {"synced": 0, "soft_deleted": 0, "active": 0, "inactive": 0}
    if not customers:
        return stats

    stats["active"] = sum(1 for c in customers if c.get('Active', True))
    stats["inactive"] = len(customers) - stats["active"]

    all_qbo_ids = [c.get('Id') for c in customers]

    with conn.cursor() as cur:
        cur.executemany("""
            INSERT INTO "Customers" (
                qbo_customer_id, display_name, company, first_name, last_name,
                email, phone, customer_type,
                street, city, state, zip,
                service_street, service_city, service_state, service_zip,
                is_active, balance, notes, qbo_last_updated, deleted_at
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, NULL)
            ON CONFLICT (qbo_customer_id) DO UPDATE SET
                display_name=EXCLUDED.display_name, company=EXCLUDED.company,
                first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
                email=EXCLUDED.email, phone=EXCLUDED.phone,
                customer_type=EXCLUDED.customer_type,
                street=EXCLUDED.street, city=EXCLUDED.city,
                state=EXCLUDED.state, zip=EXCLUDED.zip,
                service_street=EXCLUDED.service_street, service_city=EXCLUDED.service_city,
                service_state=EXCLUDED.service_state, service_zip=EXCLUDED.service_zip,
                is_active=EXCLUDED.is_active, balance=EXCLUDED.balance,
                notes=EXCLUDED.notes, qbo_last_updated=EXCLUDED.qbo_last_updated,
                deleted_at=NULL
        """, [
            (
                c.get('Id'), c.get('DisplayName'), c.get('CompanyName'),
                c.get('GivenName'), c.get('FamilyName'),
                c.get('PrimaryEmailAddr', {}).get('Address') if c.get('PrimaryEmailAddr') else None,
                c.get('PrimaryPhone', {}).get('FreeFormNumber') if c.get('PrimaryPhone') else None,
                c.get('CustomerTypeRef', {}).get('name') if c.get('CustomerTypeRef') else None,
                extract_street(c.get('BillAddr')),
                c.get('BillAddr', {}).get('City') if c.get('BillAddr') else None,
                c.get('BillAddr', {}).get('CountrySubDivisionCode') if c.get('BillAddr') else None,
                c.get('BillAddr', {}).get('PostalCode') if c.get('BillAddr') else None,
                extract_street(c.get('ShipAddr')),
                c.get('ShipAddr', {}).get('City') if c.get('ShipAddr') else None,
                c.get('ShipAddr', {}).get('CountrySubDivisionCode') if c.get('ShipAddr') else None,
                c.get('ShipAddr', {}).get('PostalCode') if c.get('ShipAddr') else None,
                c.get('Active', True), c.get('Balance'), c.get('Notes'),
                c.get('MetaData', {}).get('LastUpdatedTime'),
            )
            for c in customers
        ])
        stats["synced"] = len(customers)

        cur.execute("""
            UPDATE "Customers" SET deleted_at = NOW(), is_active = false
            WHERE qbo_customer_id IS NOT NULL AND deleted_at IS NULL
            AND qbo_customer_id != ALL(%s)
        """, (all_qbo_ids,))
        stats["soft_deleted"] = cur.rowcount
        conn.commit()

    return stats


def main():
    conn = None
    log_id = None
    current_step = "initializing"

    try:
        current_step = "connecting to database"
        conn = get_pg_connection()
        current_step = "creating sync log"
        log_id = create_sync_log(conn)
        current_step = "refreshing QBO token"
        access_token, realm_id = refresh_qbo_token()
        current_step = "fetching customers from QBO"
        customers = fetch_all_customers(access_token, realm_id)
        current_step = "syncing to Supabase"
        stats = sync_customers_to_supabase(conn, customers)
        current_step = "finalizing"
        update_sync_log(conn, log_id, "success",
                        records_synced=stats["synced"], records_deleted=stats["soft_deleted"],
                        active_count=stats["active"], inactive_count=stats["inactive"])

        return {"status": "success", "total_synced": stats["synced"],
                "active": stats["active"], "inactive": stats["inactive"],
                "soft_deleted": stats["soft_deleted"], "log_id": log_id}

    except Exception as e:
        error_msg = str(e)
        if conn and log_id:
            try:
                update_sync_log(conn, log_id, "failed", error_message=error_msg, error_step=current_step)
            except Exception:
                pass
        return {"status": "failed", "error": error_msg, "failed_at_step": current_step, "log_id": log_id}
    finally:
        if conn:
            conn.close()
