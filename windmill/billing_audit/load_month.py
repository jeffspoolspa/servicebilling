# Mirrored from Windmill: f/billing_audit/load_month
# Hash: 93115b248d6dbf4f
# Last pulled: 2026-04-07
# Summary: Load maintenance invoices for a billing month from QBO into Supabase
# Description: Pulls all invoices on the last day of the given billing month from QBO,
#   classifies them as maintenance or service based on labor SKU, and inserts maintenance
#   invoices + line items into billing_audit schema. See Windmill description for full
#   visit-count, frequency-tier, and rescue-logic explanation.

#extra_requirements:
#requests
#psycopg2-binary

import requests
import wmill
import psycopg2
import calendar
from datetime import date

LABOR_KEYWORDS = {
    "POOL MAINTENANCE": "PM",
    "FLAT RATE": "FR",
    "CHEMICAL TESTING": "CT",
    "SPA CLEAN": "SPA",
    "FOUNTAIN CLEAN": "FTN",
    "QUALITY CONTROL": "QC",
    "GREEN POOL": "GP",
    "HALF HOUR": "HH",
    "ONE TIME CLEAN": "OTC",
}


def derive_service_frequency(service_type, visit_count):
    """Derive service frequency tier from service_type and visit_count."""
    if service_type == "FR":
        return "flat_rate"
    if service_type == "OTC" or service_type == "HH+OTC":
        return "one_time"
    if service_type in ("GP", "GP+HH"):
        return "green_pool"
    if visit_count is None:
        return "unknown"
    if visit_count <= 1.5:
        return "monthly"
    if visit_count <= 3.5:
        return "biweekly"
    if visit_count <= 7.0:
        return "weekly"
    if visit_count <= 10.5:
        return "2x_weekly"
    return "high_freq"


def refresh_qbo_token():
    resource_path = "u/carter/quickbooks_api"
    resource = wmill.get_resource(resource_path)
    response = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": resource["refresh_token"]},
        auth=(resource["client_id"], resource["client_secret"])
    )
    if not response.ok:
        raise Exception(f"Token refresh failed: {response.status_code} - {response.text}")
    tokens = response.json()
    resource["refresh_token"] = tokens["refresh_token"]
    wmill.set_resource(path=resource_path, value=resource)
    return tokens["access_token"], resource["realm_id"]


def qbo_query(access_token, realm_id, query):
    base_url = f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query"
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    all_results = []
    start_pos = 1
    page_size = 1000
    while True:
        paged_query = f"{query} STARTPOSITION {start_pos} MAXRESULTS {page_size}"
        response = requests.get(base_url, headers=headers, params={"query": paged_query})
        if not response.ok:
            raise Exception(f"QBO query failed: {response.status_code} - {response.text}")
        qr = response.json().get("QueryResponse", {})
        invoices = qr.get("Invoice", [])
        all_results.extend(invoices)
        total = qr.get("totalCount", len(invoices))
        if start_pos + page_size - 1 >= total or len(invoices) < page_size:
            break
        start_pos += page_size
    return all_results


# NOTE: classify_invoice() and full main() body omitted from mirror header for brevity.
# This file mirrors the Python interface — for the full implementation see Windmill UI.
# The classify_invoice function:
#   - Walks line items
#   - Identifies labor SKUs by keyword match against LABOR_KEYWORDS
#   - Sums visit counts (excluding discounts)
#   - Derives service_type, visit_count, per_visit_rate, frequency
#   - Returns maintenance vs service classification
# The main(billing_month) function:
#   1. Idempotency check (skip if already loaded)
#   2. Pull invoices from QBO for the last day of the month
#   3. Classify each
#   4. Rescue chemical-only invoices from known maint customers
#   5. Insert maintenance invoices + line items into billing_audit
#   6. Update consumable whitelist
#   7. Auto-flag customers with labor SKUs as is_maintenance


def main(billing_month: str = "2025-11"):
    # See Windmill UI for full implementation
    raise NotImplementedError("Mirror header only — pull full source via wmill sync pull")
