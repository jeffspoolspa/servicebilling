# Process a work order: charge card/ACH or send invoice via QBO.
#
# Refactored from f/service_billing/service_billing_processing (the 47KB
# Google-Sheet-driven script). This version:
#   - Reads inputs from Supabase (work_orders + billing.invoices + billing.customer_payment_methods)
#   - No Google Sheet code
#   - No credit logic (moved to Phase 6 check_status)
#   - Writes results to billing.processing_attempts
#   - Concurrency lock via billing_status = 'processing'
#
# The 7 QBO API functions (charge_card, charge_bank_account, record_payment,
# update_invoice, send_invoice_email, send_payment_receipt, refresh_qbo_token)
# are preserved verbatim from the original.

import requests
import wmill
import psycopg2
import psycopg2.extras
import json
import uuid
from datetime import datetime

QBO_RESOURCE = "u/carter/quickbooks_api"
SUPABASE_RESOURCE = "u/carter/supabase"


# =============================================================================
# QBO API FUNCTIONS — preserved verbatim from service_billing_processing
# =============================================================================

def refresh_qbo_token():
    """Refresh QBO token and return access_token + realm_id"""
    resource_path = QBO_RESOURCE
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
    wmill.set_resource(resource_path, resource)
    return tokens["access_token"], resource["realm_id"]


def charge_card(card_id: str, amount: float, invoice_num: str, customer_name: str, access_token: str) -> dict:
    """Charge a stored card via QBO Payments API"""
    request_id = str(uuid.uuid4())
    charge_payload = {
        "amount": f"{amount:.2f}",
        "currency": "USD",
        "capture": True,
        "cardOnFile": card_id,
        "context": {"mobile": False, "isEcommerce": True},
        "description": f"Invoice {invoice_num} - {customer_name}"
    }
    charge_resp = requests.post(
        "https://api.intuit.com/quickbooks/v4/payments/charges",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Request-Id": request_id
        },
        json=charge_payload
    )
    response_data = {"request_id": request_id, "status_code": charge_resp.status_code,
                     "card_id": card_id, "amount_requested": amount}
    if not charge_resp.ok:
        error_detail = charge_resp.text or f"HTTP {charge_resp.status_code}"
        try:
            error_json = charge_resp.json()
            response_data["error_response"] = error_json
            if "errors" in error_json:
                error_detail = error_json["errors"][0].get("message", error_detail)
        except Exception:
            response_data["error_raw"] = charge_resp.text
        return {"success": False, "error": error_detail, "details": response_data, "payment_type": "card"}
    result = charge_resp.json()
    charge_status = result.get("status", "").upper()
    if charge_status != "CAPTURED":
        return {"success": False, "error": f"Card {charge_status}",
                "details": {"request_id": request_id, "charge_status": charge_status}, "payment_type": "card"}
    return {
        "success": True, "charge_id": result.get("id"), "amount": float(result.get("amount", 0)),
        "auth_code": result.get("authCode"), "status": result.get("status"),
        "card_last4": result.get("card", {}).get("number", "")[-4:],
        "card_type": result.get("card", {}).get("cardType"),
        "created": result.get("created"), "request_id": request_id, "payment_type": "card"
    }


def charge_bank_account(bank_id: str, amount: float, invoice_num: str, customer_name: str, access_token: str) -> dict:
    """Charge a stored bank account via QBO Payments eCheck API"""
    request_id = str(uuid.uuid4())
    charge_payload = {
        "amount": f"{amount:.2f}",
        "bankAccountOnFile": bank_id,
        "description": f"Invoice {invoice_num} - {customer_name}",
        "paymentMode": "WEB",
        "context": {"deviceInfo": {"macAddress": "", "ipAddress": "", "longitude": "", "latitude": "", "phoneNumber": ""}}
    }
    charge_resp = requests.post(
        "https://api.intuit.com/quickbooks/v4/payments/echecks",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Request-Id": request_id
        },
        json=charge_payload
    )
    if not charge_resp.ok:
        error_detail = charge_resp.text or f"HTTP {charge_resp.status_code}"
        try:
            error_json = charge_resp.json()
            if "errors" in error_json:
                error_detail = error_json["errors"][0].get("message", error_detail)
        except Exception:
            pass
        return {"success": False, "error": error_detail,
                "details": {"request_id": request_id, "status_code": charge_resp.status_code}, "payment_type": "ach"}
    result = charge_resp.json()
    charge_status = result.get("status", "").upper()
    if charge_status not in ["PENDING", "SUCCEEDED"]:
        return {"success": False, "error": f"ACH {charge_status}",
                "details": {"request_id": request_id, "charge_status": charge_status}, "payment_type": "ach"}
    return {
        "success": True, "charge_id": result.get("id"), "amount": float(result.get("amount", 0)),
        "auth_code": result.get("authCode", ""), "status": result.get("status"),
        "card_last4": result.get("bankAccount", {}).get("accountNumber", "")[-4:],
        "card_type": "ACH", "created": result.get("created"),
        "request_id": request_id, "payment_type": "ach"
    }


def record_payment(customer_id: str, invoice_id: str, amount: float, charge_result: dict,
                   wo_num: str, invoice_num: str, access_token: str, realm_id: str) -> dict:
    """Record a payment in QBO linked to an invoice"""
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json", "Content-Type": "application/json"}
    charge_id = charge_result.get("charge_id", "")
    auth_code = charge_result.get("auth_code", "")
    card_type = charge_result.get("card_type", "")
    card_last4 = charge_result.get("card_last4", "")
    private_note = f"Auto-charge | WO# {wo_num} | Inv# {invoice_num} | Charge ID: {charge_id} | Auth: {auth_code} | {card_type} x{card_last4} | {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    payment_data = {
        "CustomerRef": {"value": customer_id},
        "TotalAmt": amount,
        "PaymentMethodRef": {"value": "20" if charge_result.get("payment_type") == "ach" else "21"},
        "PaymentRefNum": wo_num,
        "TxnDate": datetime.now().strftime("%Y-%m-%d"),
        "Line": [{"Amount": amount, "LinkedTxn": [{"TxnId": invoice_id, "TxnType": "Invoice"}]}],
        "PrivateNote": private_note,
        "CreditCardPayment": {
            "CreditChargeInfo": {"ProcessPayment": True, "Amount": amount},
            "CreditChargeResponse": {"Status": "Completed", "CCTransId": charge_id}
        },
        "TxnSource": "IntuitPayment"
    }
    create_resp = requests.post(
        f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/payment",
        headers=headers, json=payment_data
    )
    if not create_resp.ok:
        return {"success": False, "error": create_resp.text[:300], "status_code": create_resp.status_code}
    payment = create_resp.json().get("Payment", {})
    return {"success": True, "payment_id": payment.get("Id"), "payment_ref": payment.get("PaymentRefNum"),
            "total_amt": payment.get("TotalAmt")}


def update_invoice(invoice_id: str, memo: str, access_token: str, realm_id: str) -> dict:
    """Update invoice with due date = today and memos. Fetches fresh sync_token."""
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json", "Content-Type": "application/json"}
    inv_resp = requests.get(f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/invoice/{invoice_id}", headers=headers)
    if not inv_resp.ok:
        return {"success": False, "error": f"Failed to fetch invoice: {inv_resp.status_code}"}
    current_invoice = inv_resp.json().get("Invoice", {})
    sync_token = current_invoice.get("SyncToken")
    update_data = {"Id": invoice_id, "SyncToken": sync_token, "sparse": True,
                   "DueDate": datetime.now().strftime("%Y-%m-%d")}
    if memo:
        update_data["PrivateNote"] = memo
        update_data["CustomerMemo"] = {"value": memo}
    update_resp = requests.post(f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/invoice",
                                headers=headers, json=update_data)
    if not update_resp.ok:
        return {"success": False, "error": update_resp.text[:300]}
    return {"success": True}


def send_invoice_email(invoice_id: str, customer_id: str, access_token: str, realm_id: str) -> dict:
    """Send invoice via QBO email if not already sent"""
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    inv_resp = requests.get(f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/invoice/{invoice_id}", headers=headers)
    if inv_resp.ok:
        invoice = inv_resp.json().get("Invoice", {})
        if invoice.get("EmailStatus") == "EmailSent":
            return {"success": True, "skipped": True, "reason": "Already sent"}
    customer_resp = requests.get(f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/customer/{customer_id}", headers=headers)
    email_address = None
    if customer_resp.ok:
        email_address = customer_resp.json().get("Customer", {}).get("PrimaryEmailAddr", {}).get("Address")
    send_url = f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/invoice/{invoice_id}/send"
    if email_address:
        send_url += f"?sendTo={email_address}"
    send_resp = requests.post(send_url, headers={
        "Authorization": f"Bearer {access_token}", "Accept": "application/json", "Content-Type": "application/octet-stream"
    })
    if not send_resp.ok:
        return {"success": False, "error": send_resp.text[:300], "email_attempted": email_address}
    return {"success": True, "sent_to": email_address}


def send_payment_receipt(payment_id: str, customer_id: str, access_token: str, realm_id: str) -> dict:
    """Send payment receipt via QBO email"""
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    customer_resp = requests.get(f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/customer/{customer_id}", headers=headers)
    email_address = None
    if customer_resp.ok:
        email_address = customer_resp.json().get("Customer", {}).get("PrimaryEmailAddr", {}).get("Address")
    if not email_address:
        return {"success": False, "error": "No customer email found"}
    send_url = f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/payment/{payment_id}/send?sendTo={email_address}"
    send_resp = requests.post(send_url, headers={
        "Authorization": f"Bearer {access_token}", "Accept": "application/json", "Content-Type": "application/octet-stream"
    })
    if not send_resp.ok:
        return {"success": False, "error": send_resp.text[:300], "email_attempted": email_address}
    return {"success": True, "sent_to": email_address}


# =============================================================================
# SUPABASE HELPERS — new for refactor
# =============================================================================

def get_db_conn():
    sb = wmill.get_resource(SUPABASE_RESOURCE)
    return psycopg2.connect(
        host=sb["host"], port=sb.get("port", 6543),
        dbname=sb.get("dbname", "postgres"), user=sb["user"],
        password=sb["password"], sslmode=sb.get("sslmode", "require"),
    )


def acquire_lock(conn, wo_number: str) -> dict | None:
    """Set billing_status = 'processing' atomically. Returns the WO row, or None if lock failed."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        UPDATE public.work_orders
        SET billing_status = 'processing', billing_status_set_at = now()
        WHERE wo_number = %s AND billing_status = 'ready_to_process'
        RETURNING *
    """, (wo_number,))
    row = cur.fetchone()
    conn.commit()
    cur.close()
    return dict(row) if row else None


def release_lock(conn, wo_number: str, status: str, needs_review_reason: str | None = None):
    """Set final billing_status after processing."""
    cur = conn.cursor()
    cur.execute("""
        UPDATE public.work_orders
        SET billing_status = %s, billing_status_set_at = now(),
            needs_review_reason = %s, last_synced_at = now()
        WHERE wo_number = %s
    """, (status, needs_review_reason, wo_number))
    conn.commit()
    cur.close()


def get_cached_invoice(conn, invoice_number: str) -> dict | None:
    """Read from billing.invoices cache."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM billing.invoices WHERE doc_number = %s", (invoice_number,))
    row = cur.fetchone()
    cur.close()
    return dict(row) if row else None


def get_cached_payment_method(conn, qbo_customer_id: str) -> dict | None:
    """Read the best active payment method for a customer from cache (card preferred over ACH)."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT * FROM billing.customer_payment_methods
        WHERE qbo_customer_id = %s AND is_active = true
        ORDER BY
            CASE type WHEN 'card' THEN 0 ELSE 1 END,
            is_default DESC,
            fetched_at DESC
        LIMIT 1
    """, (qbo_customer_id,))
    row = cur.fetchone()
    cur.close()
    return dict(row) if row else None


def log_processing_attempt(conn, wo_number: str, result: dict):
    """Insert into billing.processing_attempts."""
    cur = conn.cursor()
    charge_result = result.get("charge_result") or {}
    cur.execute("""
        INSERT INTO billing.processing_attempts
            (wo_number, invoice_number, qbo_invoice_id, attempted_at,
             status, payment_method, charge_amount, charge_result,
             credits_applied, email_sent, error_message, raw_result)
        VALUES (%s, %s, %s, now(), %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s::jsonb)
    """, (
        wo_number,
        result.get("invoice_number"),
        result.get("qbo_invoice_id"),
        result.get("status", "failed"),
        result.get("payment_method"),
        result.get("charge_amount"),
        json.dumps(charge_result) if charge_result else None,
        json.dumps(result.get("credits_applied")) if result.get("credits_applied") else None,
        result.get("email_sent", False),
        result.get("error_message"),
        json.dumps(result) if result else None,
    ))
    conn.commit()
    cur.close()


def get_matched_credits(conn, wo_number: str) -> list[dict]:
    """Get credits matched to this WO from billing.open_credits."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT qbo_payment_id, type, unapplied_amt, matched_amount, match_reason, raw
        FROM billing.open_credits
        WHERE matched_wo_number = %s AND matched_amount > 0
        ORDER BY matched_amount DESC
    """, (wo_number,))
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    return rows


def apply_credit_in_qbo(credit_id: str, credit_type: str, invoice_id: str,
                         amount: float, access_token: str, realm_id: str) -> dict:
    """Link a QBO Payment or CreditMemo to an Invoice.

    For Payments: GET the Payment, append a Line linking it to the Invoice, POST update.
    For CreditMemos: similar but uses the CreditMemo entity.
    This is the same apply_credits logic from the original service_billing_processing.
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    try:
        if credit_type == "credit_memo":
            # CreditMemo IDs are stored as "CM-{id}" — strip prefix
            cm_id = credit_id.replace("CM-", "")

            # Fetch current CreditMemo
            cm_resp = requests.get(
                f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/creditmemo/{cm_id}",
                headers=headers,
            )
            if not cm_resp.ok:
                return {"success": False, "error": f"Failed to fetch CreditMemo {cm_id}: {cm_resp.status_code}"}

            # Apply CreditMemo to Invoice via Payment endpoint
            payment_data = {
                "CustomerRef": cm_resp.json().get("CreditMemo", {}).get("CustomerRef"),
                "TotalAmt": 0,
                "Line": [{
                    "Amount": amount,
                    "LinkedTxn": [
                        {"TxnId": cm_id, "TxnType": "CreditMemo"},
                        {"TxnId": invoice_id, "TxnType": "Invoice"},
                    ]
                }],
            }
            apply_resp = requests.post(
                f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/payment",
                headers=headers, json=payment_data,
            )
            if not apply_resp.ok:
                return {"success": False, "error": f"CreditMemo apply failed: {apply_resp.text[:300]}"}
            return {"success": True}

        else:
            # Payment: GET current, add Line linking to Invoice, POST update
            pmt_resp = requests.get(
                f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/payment/{credit_id}",
                headers=headers,
            )
            if not pmt_resp.ok:
                return {"success": False, "error": f"Failed to fetch Payment {credit_id}: {pmt_resp.status_code}"}

            payment = pmt_resp.json().get("Payment", {})
            existing_lines = payment.get("Line", [])
            existing_lines.append({
                "Amount": amount,
                "LinkedTxn": [{"TxnId": invoice_id, "TxnType": "Invoice"}]
            })
            payment["Line"] = existing_lines
            payment["sparse"] = True

            update_resp = requests.post(
                f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/payment",
                headers=headers, json=payment,
            )
            if not update_resp.ok:
                return {"success": False, "error": f"Payment apply failed: {update_resp.text[:300]}"}
            return {"success": True}

    except Exception as e:
        return {"success": False, "error": str(e)}


def update_invoice_cache(conn, invoice_number: str, balance: float, email_status: str):
    """Update billing.invoices cache after processing."""
    cur = conn.cursor()
    cur.execute("""
        UPDATE billing.invoices
        SET balance = %s, email_status = %s, fetched_at = now()
        WHERE doc_number = %s
    """, (balance, email_status, invoice_number))
    conn.commit()
    cur.close()


# =============================================================================
# MAIN
# =============================================================================

def process_one(conn, wo_number: str, access_token: str, realm_id: str, dry_run: bool = False) -> dict:
    """Process a single work order. Returns result dict."""
    result = {
        "wo_number": wo_number,
        "status": None,
        "error_message": None,
        "invoice_number": None,
        "qbo_invoice_id": None,
        "payment_method": None,
        "charge_amount": None,
        "charge_result": None,
        "credits_applied": None,
        "email_sent": False,
    }

    # ── 1. ACQUIRE LOCK ──────────────────────────────────────────────
    wo = acquire_lock(conn, wo_number)
    if not wo:
        result["status"] = "skipped"
        result["error_message"] = "Not in ready_to_process (already processing or wrong state)"
        return result

    invoice_number = wo.get("invoice_number")
    payment_method = wo.get("payment_method")  # 'on_file' or 'invoice'
    customer_name = wo.get("customer", "")
    wo_subtotal = float(wo.get("sub_total") or 0)
    description = wo.get("work_description") or ""
    result["invoice_number"] = invoice_number
    result["payment_method"] = payment_method

    try:
        # ── 2. READ CACHED INVOICE ──────────────────────────────────
        cached = get_cached_invoice(conn, invoice_number)
        if not cached:
            # Fall back to live QBO lookup
            live = lookup_invoice(invoice_number, access_token, realm_id)
            if not live["found"]:
                result["status"] = "failed"
                result["error_message"] = f"Invoice {invoice_number} not found in QBO"
                release_lock(conn, wo_number, "needs_review", result["error_message"])
                log_processing_attempt(conn, wo_number, result)
                return result
            qbo_invoice_id = live["invoice_id"]
            qbo_customer_id = live["customer_id"]
            qbo_subtotal = live["subtotal"]
            qbo_balance = live["balance"]
            email_status = live["email_status"]
        else:
            qbo_invoice_id = cached["qbo_invoice_id"]
            qbo_customer_id = cached.get("qbo_customer_id")
            qbo_subtotal = float(cached.get("subtotal") or cached.get("total_amt") or 0)
            qbo_balance = float(cached.get("balance") or 0)
            email_status = cached.get("email_status")

        result["qbo_invoice_id"] = qbo_invoice_id

        # ── 3. ALREADY PROCESSED? ──────────────────────────────────
        if email_status == "EmailSent":
            is_paid = qbo_balance == 0
            result["status"] = "success"
            result["email_sent"] = True
            release_lock(conn, wo_number, "processed")
            update_invoice_cache(conn, invoice_number, qbo_balance, email_status)
            log_processing_attempt(conn, wo_number, result)
            return result

        # ── 4. VALIDATE SUBTOTAL ──────────────────────────────────
        if wo_subtotal > 0 and qbo_subtotal > 0 and abs(qbo_subtotal - wo_subtotal) >= 0.02:
            result["status"] = "failed"
            result["error_message"] = f"Subtotal mismatch: WO ${wo_subtotal:.2f} vs QBO ${qbo_subtotal:.2f}"
            release_lock(conn, wo_number, "needs_review", result["error_message"])
            log_processing_attempt(conn, wo_number, result)
            return result

        if dry_run:
            matched = get_matched_credits(conn, wo_number)
            pm = get_cached_payment_method(conn, qbo_customer_id) if payment_method == "on_file" and qbo_balance > 0 else None
            pm_info = f"{pm['type']} x{pm['last_four']}" if pm else "n/a"
            result["status"] = "skipped"
            result["credits_applied"] = [{"id": c["qbo_payment_id"], "amount": float(c["matched_amount"])} for c in matched]
            result["error_message"] = f"dry_run — credits: {len(matched)} (${sum(float(c['matched_amount']) for c in matched):.2f}), charge remainder via {pm_info}, balance=${qbo_balance:.2f}"
            release_lock(conn, wo_number, "ready_to_process")
            return result

        # ── 5. APPLY MATCHED CREDITS IN QBO ──────────────────────
        matched_credits = get_matched_credits(conn, wo_number)
        credits_applied = []
        remaining_balance = qbo_balance

        for mc in matched_credits:
            apply_amount = min(float(mc["matched_amount"]), remaining_balance)
            if apply_amount <= 0:
                break

            apply_result = apply_credit_in_qbo(
                credit_id=mc["qbo_payment_id"],
                credit_type=mc["type"],
                invoice_id=qbo_invoice_id,
                amount=apply_amount,
                access_token=access_token,
                realm_id=realm_id,
            )

            credits_applied.append({
                "credit_id": mc["qbo_payment_id"],
                "amount": apply_amount,
                "success": apply_result["success"],
                "error": apply_result.get("error"),
            })

            if apply_result["success"]:
                remaining_balance -= apply_amount
                # Mark credit as used in our table
                cur = conn.cursor()
                cur.execute("""
                    UPDATE billing.open_credits
                    SET unapplied_amt = GREATEST(unapplied_amt - %s, 0)
                    WHERE qbo_payment_id = %s
                """, (apply_amount, mc["qbo_payment_id"]))
                conn.commit()
                cur.close()
            else:
                print(f"  credit apply failed for {mc['qbo_payment_id']}: {apply_result.get('error')}")

        result["credits_applied"] = credits_applied
        if credits_applied:
            print(f"  applied {len(credits_applied)} credits, remaining balance: ${remaining_balance:.2f}")

        # ── 6. CHARGE REMAINDER (on_file only) ───────────────────
        if payment_method == "on_file" and remaining_balance > 0:
            # Get cached payment method
            pm = get_cached_payment_method(conn, qbo_customer_id)
            if not pm:
                result["status"] = "failed"
                result["error_message"] = "No active payment method cached for this customer"
                release_lock(conn, wo_number, "needs_review", result["error_message"])
                log_processing_attempt(conn, wo_number, result)
                return result

            charge_amount = remaining_balance
            result["charge_amount"] = charge_amount

            # Charge
            if pm["type"] == "card":
                charge_result = charge_card(
                    pm["qbo_payment_method_id"], charge_amount,
                    invoice_number, customer_name, access_token
                )
            else:
                charge_result = charge_bank_account(
                    pm["qbo_payment_method_id"], charge_amount,
                    invoice_number, customer_name, access_token
                )

            result["charge_result"] = charge_result

            if not charge_result["success"]:
                error_label = "Card Declined" if pm["type"] == "card" else "ACH Failed"
                result["status"] = "failed"
                result["error_message"] = f"{error_label}: {charge_result.get('error', 'Unknown')}"
                release_lock(conn, wo_number, "needs_review", result["error_message"])
                log_processing_attempt(conn, wo_number, result)
                return result

            # Safety check
            if not charge_result.get("charge_id"):
                result["status"] = "failed"
                result["error_message"] = f"Charge response unclear: {charge_result}"
                release_lock(conn, wo_number, "needs_review", result["error_message"])
                log_processing_attempt(conn, wo_number, result)
                return result

            # Record payment in QBO
            payment_result = record_payment(
                qbo_customer_id, qbo_invoice_id, charge_amount, charge_result,
                wo_number, invoice_number, access_token, realm_id
            )

            if not payment_result["success"]:
                charge_label = "CARD CHARGED" if pm["type"] == "card" else "ACH INITIATED"
                result["status"] = "partial"
                result["error_message"] = f"{charge_label} ${charge_amount:.2f} but QBO payment failed: {payment_result.get('error')}"
                release_lock(conn, wo_number, "needs_review", result["error_message"])
                log_processing_attempt(conn, wo_number, result)
                return result

            # Send payment receipt
            send_payment_receipt(
                payment_result["payment_id"], qbo_customer_id, access_token, realm_id
            )

        # ── 6. UPDATE INVOICE (due date + memo) ──────────────────
        update_result = update_invoice(qbo_invoice_id, description, access_token, realm_id)
        if not update_result["success"]:
            result["status"] = "failed"
            result["error_message"] = f"Invoice update failed: {update_result.get('error')}"
            release_lock(conn, wo_number, "needs_review", result["error_message"])
            log_processing_attempt(conn, wo_number, result)
            return result

        # ── 7. SEND INVOICE EMAIL ────────────────────────────────
        email_result = send_invoice_email(qbo_invoice_id, qbo_customer_id, access_token, realm_id)
        result["email_sent"] = email_result["success"]

        if not email_result["success"] and not email_result.get("skipped"):
            result["status"] = "failed"
            result["error_message"] = f"Email failed: {email_result.get('error')}"
            release_lock(conn, wo_number, "needs_review", result["error_message"])
            log_processing_attempt(conn, wo_number, result)
            return result

        # ── 8. SUCCESS ───────────────────────────────────────────
        # Re-check invoice to get final balance
        live_check = lookup_invoice(invoice_number, access_token, realm_id)
        final_balance = live_check.get("balance", qbo_balance) if live_check.get("found") else qbo_balance

        result["status"] = "success"
        release_lock(conn, wo_number, "processed")
        update_invoice_cache(conn, invoice_number, final_balance, "EmailSent")
        log_processing_attempt(conn, wo_number, result)
        return result

    except Exception as e:
        result["status"] = "failed"
        result["error_message"] = str(e)[:500]
        try:
            release_lock(conn, wo_number, "needs_review", result["error_message"])
            log_processing_attempt(conn, wo_number, result)
        except Exception:
            pass
        return result


def lookup_invoice(invoice_num: str, access_token: str, realm_id: str) -> dict:
    """Find invoice in QBO by DocNumber (preserved from original)"""
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    query = f"SELECT * FROM Invoice WHERE DocNumber = '{invoice_num}'"
    resp = requests.get(
        f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/query",
        headers=headers, params={"query": query}
    )
    if not resp.ok:
        return {"found": False, "error": f"Query failed: {resp.status_code}"}
    invoices = resp.json().get("QueryResponse", {}).get("Invoice", [])
    if not invoices:
        return {"found": False, "error": "Invoice not found in QBO"}
    inv = invoices[0]
    qbo_total = float(inv.get("TotalAmt", 0))
    qbo_tax = float(inv.get("TxnTaxDetail", {}).get("TotalTax", 0))
    return {
        "found": True, "invoice_id": inv.get("Id"), "sync_token": inv.get("SyncToken"),
        "customer_id": inv.get("CustomerRef", {}).get("value"),
        "customer_name": inv.get("CustomerRef", {}).get("name"),
        "txn_date": inv.get("TxnDate"), "total_amt": qbo_total, "tax_amt": qbo_tax,
        "subtotal": round(qbo_total - qbo_tax, 2),
        "balance": float(inv.get("Balance", 0)), "email_status": inv.get("EmailStatus")
    }


def main(
    wo_numbers: list[str] | None = None,
    wo_number: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Process one or many work orders.

    Args:
        wo_numbers: List of WO numbers to process (batch).
        wo_number: Single WO number (convenience alias).
        dry_run: If True, validate inputs but don't charge or send.
    """
    targets = wo_numbers or ([wo_number] if wo_number else [])
    if not targets:
        return {"error": "Provide wo_number or wo_numbers"}

    print(f"=== process_work_order started ({len(targets)} WOs, dry_run={dry_run}) ===")

    conn = get_db_conn()
    access_token, realm_id = refresh_qbo_token()

    results = []
    stats = {"success": 0, "failed": 0, "skipped": 0, "partial": 0}

    for i, wn in enumerate(targets):
        print(f"  [{i + 1}/{len(targets)}] WO {wn}...")
        r = process_one(conn, wn, access_token, realm_id, dry_run)
        results.append(r)
        s = r.get("status", "failed")
        stats[s] = stats.get(s, 0) + 1
        print(f"    → {s}" + (f": {r.get('error_message')}" if r.get("error_message") else ""))

    conn.close()

    print(f"=== done: {stats} ===")
    return {
        "dry_run": dry_run,
        "total": len(targets),
        "stats": stats,
        "results": results,
    }
