# Mirrored from Windmill: f/service_billing/distinguished_script
# (display name: servicebilling_check_status)
# Hash: 45949c6c419d6857
# Last pulled: 2026-04-07
# Summary: Check invoice status and update Google Sheet SYNCED/SENT/PAID columns
# Description: Query QBO for invoice status using IN clause + MAXRESULTS for efficiency.
#   ~7 QBO API calls instead of ~2700. Reads invoice numbers from "All WOs" sheet
#   (column E), then writes back SYNCED (P), SENT (Q), PAID (R) columns.
#
# Phase 6 refactor target: instead of reading the Google Sheet, this will read
# from public.work_orders WHERE billing_status IN ('processed', 'ready_to_process')
# AND invoice_number IS NOT NULL, then write back to:
#   - billing.invoices (cache: balance, email_status, fetched_at)
#   - work_orders.last_synced_at
#   - work_orders.billing_status (transition: ready_to_process → processed when paid+sent)

import requests
import wmill
from datetime import datetime

SPREADSHEET_ID = "1uI54DP-Wj0p06G2rwNHfob6LIu150YsMokEZeT_D5tE"
SHEET_NAME = "All WOs"
SHEET_BATCH_SIZE = 50
QBO_IN_BATCH_SIZE = 400  # Keep under URI length limit


def refresh_qbo_token():
    """Refresh QBO token and return access_token + realm_id"""
    resource_path = "u/carter/quickbooks_api"
    resource = wmill.get_resource(resource_path)
    response = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": resource["refresh_token"]},
        auth=(resource["client_id"], resource["client_secret"])
    )
    if not response.ok:
        raise Exception(f"Token refresh failed: {response.status_code}")
    tokens = response.json()
    resource["refresh_token"] = tokens["refresh_token"]
    wmill.set_resource(resource_path, resource)
    return tokens["access_token"], resource["realm_id"]


def batch_query_invoices(doc_numbers: list, access_token: str, realm_id: str) -> dict:
    """Query invoices using IN clause with MAXRESULTS.
    Returns {doc_number: {email_status, balance}}"""
    if not doc_numbers:
        return {}

    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    result = {}

    for i in range(0, len(doc_numbers), QBO_IN_BATCH_SIZE):
        batch = doc_numbers[i:i + QBO_IN_BATCH_SIZE]
        in_values = ", ".join([f"'{d}'" for d in batch])
        query = f"SELECT DocNumber, EmailStatus, Balance FROM Invoice WHERE DocNumber IN ({in_values}) MAXRESULTS 1000"

        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query",
            headers=headers, params={"query": query}
        )

        if resp.ok:
            for inv in resp.json().get("QueryResponse", {}).get("Invoice", []):
                doc_num = inv.get("DocNumber")
                if doc_num:
                    result[str(doc_num)] = {
                        "email_status": inv.get("EmailStatus"),
                        "balance": float(inv.get("Balance", 0))
                    }

    return result


def get_sheets_token():
    return wmill.get_resource("u/carter/gsheets").get("token")


def read_sheet_data(token: str) -> list:
    """Read columns D-R from the All WOs sheet"""
    range_name = f"'{SHEET_NAME}'!D:R"
    resp = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{range_name}",
        headers={"Authorization": f"Bearer {token}"}
    )
    if not resp.ok:
        raise Exception(f"Failed to read sheet: {resp.status_code}")

    values = resp.json().get("values", [])
    data = []
    for i, row in enumerate(values):
        if i == 0:
            continue
        def get_val(idx):
            return str(row[idx]).strip() if len(row) > idx and row[idx] else ""
        data.append({
            "actual_row": i + 1,
            "invoice": get_val(1),   # E - Invoice #
            "synced": get_val(12),   # P - SYNCED
            "sent": get_val(13),     # Q - SENT
            "paid": get_val(14)      # R - PAID
        })
    return data


def batch_update_sheet(token: str, updates: list):
    if not updates:
        return
    data = []
    for u in updates:
        row = u["actual_row"]
        data.append({
            "range": f"'{SHEET_NAME}'!P{row}:R{row}",
            "values": [[u["synced"], u["sent"], u["paid"]]]
        })
    for i in range(0, len(data), SHEET_BATCH_SIZE):
        batch = data[i:i + SHEET_BATCH_SIZE]
        requests.post(
            f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values:batchUpdate",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"valueInputOption": "USER_ENTERED", "data": batch}
        )


def main(dry_run: bool = False) -> dict:
    """Check invoice status for all rows with invoice numbers."""
    result = {"started": datetime.now().isoformat()}

    access_token, realm_id = refresh_qbo_token()
    sheets_token = get_sheets_token()
    sheet_data = read_sheet_data(sheets_token)

    rows_to_check = [
        r for r in sheet_data
        if r["invoice"]
        and not (r["synced"].upper() == "TRUE" and r["sent"].upper() == "TRUE" and r["paid"].upper() == "TRUE")
    ]

    invoice_numbers = list(set(r["invoice"] for r in rows_to_check))
    result["rows_to_check"] = len(rows_to_check)
    result["unique_invoices"] = len(invoice_numbers)
    result["qbo_api_calls"] = (len(invoice_numbers) + QBO_IN_BATCH_SIZE - 1) // QBO_IN_BATCH_SIZE

    qbo_data = batch_query_invoices(invoice_numbers, access_token, realm_id)
    result["qbo_found"] = len(qbo_data)

    updates = []
    stats = {"synced": 0, "sent": 0, "paid": 0, "not_found": 0}

    for row in rows_to_check:
        inv_num = row["invoice"]
        if inv_num in qbo_data:
            inv = qbo_data[inv_num]
            synced = "TRUE"
            sent = "TRUE" if inv["email_status"] == "EmailSent" else "FALSE"
            paid = "TRUE" if inv["balance"] == 0 else "FALSE"
            stats["synced"] += 1
            if sent == "TRUE": stats["sent"] += 1
            if paid == "TRUE": stats["paid"] += 1
        else:
            synced = "FALSE"
            sent = ""
            paid = ""
            stats["not_found"] += 1

        updates.append({
            "actual_row": row["actual_row"],
            "synced": synced, "sent": sent, "paid": paid
        })

    result.update(stats)
    result["rows_updated"] = len(updates)

    if not dry_run and updates:
        batch_update_sheet(sheets_token, updates)

    result["completed"] = datetime.now().isoformat()
    result["dry_run"] = dry_run
    return result
