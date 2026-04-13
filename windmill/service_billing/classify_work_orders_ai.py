# Classify work orders using Claude AI.
#
# For each awaiting_invoice WO with a cached invoice:
#   1. Build a prompt with WO data + few-shot examples
#   2. Call Claude for structured classification (service_category + qbo_class)
#   3. If confidence >= 0.9 → auto-apply + run validation (subtotal, credits, payment method)
#   4. If confidence < 0.9 → needs_review with AI's reasoning
#
# Payment method and office are mechanical (not AI):
#   - Payment method: *bill* override → invoice, card on file → on_file, else → invoice
#   - Office: derived from the technician's branch in the employees table
#
# Schedule: runs after pull_qbo_invoices (every 4h) or on demand.

import wmill
import psycopg2
import psycopg2.extras
import json
import requests
from datetime import datetime, timezone

SUPABASE_RESOURCE = "u/carter/supabase"
CONFIDENCE_THRESHOLD = 0.9

SYSTEM_PROMPT = """You classify work orders for Jeff's Pool & Spa Service, a pool service company in coastal Georgia.

Given a work order's details, return a JSON object with:
- service_category: one of ["service", "delivery", "maintenance", "warranty", "install", "estimate", "internal"]
- qbo_class: the QuickBooks class name — one of ["Service", "Delivery", "Maintenance", "Warranty", "Install", "Estimate", null]
  (null for internal/non-billable categories that don't map to a QBO class)
- confidence: 0.0 to 1.0 — how confident you are in this classification
- reasoning: brief explanation of why you chose this classification (1 sentence)

Classification guidance:
- "service" = any billable service call: repairs, diagnoses, inspections, pump/motor/heater work, leak detection, green pool recovery, pool school, equipment troubleshooting. This is the most common category.
- "delivery" = parts/chemicals delivered or installed during a delivery trip. Often skimmer baskets, filter cartridges, chemicals (tabs, shock, acid, bicarb), polaris bags, hoses. The work description usually mentions "deliver", "replace basket", or lists specific parts.
- "maintenance" = recurring maintenance visits, chemical checks, hot tub service, sand changes done during maintenance. Usually tied to a maintenance schedule.
- "warranty" = warranty claims where the manufacturer covers the part. Customer pays labor only. Description usually mentions "warranty", "claim", or references a prior install date and manufacturer.
- "install" = new equipment installations, liner replacements, major renovations. Large ticket items ($1000+). Description mentions "install", "liner", "renovation".
- "estimate" = site visit to quote future work. Description mentions "estimate", "quote", "diagnose and prepare quote".
- "internal" = quality control visits, helper tickets, internal work that shouldn't be invoiced as a standalone service category. These may still have billable charges attached.

Important: the WO "type" field from ION is a hint but NOT definitive. A "GENERAL SERVICE" type might actually be a delivery if the description says "deliver and install basket". A "MAINTENANCE" type might be a service call if it describes a one-time repair. READ THE DESCRIPTION to classify accurately.

Return ONLY valid JSON, no markdown."""

FEW_SHOT_EXAMPLES = [
    {
        "input": {"type": "GENERAL SERVICE", "description": "Customer called and said the fountain pump is tripping the breaker.", "corrective": "Pump install on Fountain", "total": 1553.99},
        "output": {"service_category": "service", "qbo_class": "Service", "confidence": 0.95, "reasoning": "Pump repair/replacement is a service call despite being a significant install — it's reactive troubleshooting, not a planned installation."}
    },
    {
        "input": {"type": "DELIVERY", "description": "Deliver 8 bags zeofiber", "corrective": "Delivered the 2", "total": 402.23},
        "output": {"service_category": "delivery", "qbo_class": "Delivery", "confidence": 0.98, "reasoning": "Straightforward chemical/media delivery."}
    },
    {
        "input": {"type": "DELIVERY", "description": "Approved to replace pump lid gasket. Part will be delivered and installed on your normal maintenance. No labor charges", "corrective": "Part replaced", "total": 48.99},
        "output": {"service_category": "delivery", "qbo_class": "Delivery", "confidence": 0.92, "reasoning": "Part delivery with install on maintenance visit — classified as delivery because the WO is for the part, not the maintenance."}
    },
    {
        "input": {"type": "GENERAL SERVICE", "description": "Customer wants us to send a technician to turn the heater on to 90°. Code Front door 9552. Make sure gas valve is on.", "corrective": "Difficulty getting access to controller. Aaron left heater in standalone operation.", "total": 135.00},
        "output": {"service_category": "service", "qbo_class": "Service", "confidence": 0.97, "reasoning": "On-site service call for heater operation — standard service visit."}
    },
    {
        "input": {"type": "WARRANTY", "description": "PARTS ONLY WARRANTY CUSTOMER MUST PAY LABOR. PD-165 Pump installed 7/11/2023. Waterway will cover pump only no labor.", "corrective": "Replace warranty pump. Check ok", "total": 212.58},
        "output": {"service_category": "warranty", "qbo_class": "Warranty", "confidence": 0.99, "reasoning": "Explicit warranty claim — manufacturer covers part, customer pays labor."}
    },
    {
        "input": {"type": "ESTIMATE", "description": "Green Pool Estimate. Vinyl pool. 3 to 5 visits. Filters and salt cell will need to be cleaned.", "corrective": "Green pool started.", "total": 500.00},
        "output": {"service_category": "estimate", "qbo_class": "Estimate", "confidence": 0.95, "reasoning": "Site assessment and quote for green pool recovery work."}
    },
    {
        "input": {"type": "MAINTENANCE", "description": "Dive pool and install pool light. Check filter media, technicians reporting constant high pressures.", "corrective": "Found 3 leaks in the pool we repaired. Also got the light in correctly.", "total": 381.99},
        "output": {"service_category": "maintenance", "qbo_class": "Maintenance", "confidence": 0.85, "reasoning": "Labeled maintenance but involves significant repair work (leak repair + light install). Keeping as maintenance since it was done during a maintenance-scheduled visit, but confidence is lower because of the repair scope."}
    },
    {
        "input": {"type": "LINER", "description": "Liner estimate - this estimate does not include tax. If approved a deposit of 50% is required.", "corrective": "Liner Install", "total": 5847.00},
        "output": {"service_category": "install", "qbo_class": "Install", "confidence": 0.99, "reasoning": "Liner replacement is a major installation job."}
    },
    {
        "input": {"type": "QUALITY CONTROL", "description": "Customer called in and said pool is losing lots of water, and they do not want tech back that's been servicing their pool.", "corrective": ".", "total": 200.99},
        "output": {"service_category": "internal", "qbo_class": null, "confidence": 0.80, "reasoning": "Quality control visit triggered by customer complaint — internal category, though it has billable charges which may need review."}
    },
    {
        "input": {"type": "GO BACK", "description": "Customer called and we replaced his 2hp Sta-rite with a 1hp super pump with TFEC motor. Customer says pump is making a loud noise.", "corrective": "Fix pump suction side with new manifold and three way.", "total": 99.99},
        "output": {"service_category": "service", "qbo_class": "Service", "confidence": 0.93, "reasoning": "Follow-up service call to fix noise issue after prior pump replacement — service, not warranty (different issue from original install)."}
    }
]


def get_db_conn():
    sb = wmill.get_resource(SUPABASE_RESOURCE)
    return psycopg2.connect(
        host=sb["host"], port=sb.get("port", 6543),
        dbname=sb.get("dbname", "postgres"), user=sb["user"],
        password=sb["password"], sslmode=sb.get("sslmode", "require"),
    )


def classify_with_claude(wo: dict, api_key: str) -> dict:
    """Call Claude to classify a single work order."""
    user_msg = json.dumps({
        "type": wo.get("type"),
        "description": wo.get("work_description") or "",
        "corrective": wo.get("corrective_action") or "",
        "total": float(wo.get("total_due") or 0),
        "template": wo.get("template") or "",
        "customer": wo.get("customer") or "",
    })

    examples_text = ""
    for ex in FEW_SHOT_EXAMPLES:
        examples_text += f"\nInput: {json.dumps(ex['input'])}\nOutput: {json.dumps(ex['output'])}\n"

    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 256,
            "system": SYSTEM_PROMPT + "\n\nExamples:" + examples_text,
            "messages": [{"role": "user", "content": user_msg}],
        },
        timeout=30,
    )

    if not resp.ok:
        return {"error": f"Claude API {resp.status_code}: {resp.text[:200]}"}

    text = resp.json()["content"][0]["text"].strip()
    # Parse JSON from response (handle markdown wrapping)
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": f"Failed to parse: {text[:200]}"}


def main(limit: int = None, confidence_threshold: float = 0.9):
    """Classify awaiting_invoice WOs with cached invoices using Claude.

    Args:
        limit: Max WOs to classify (for testing).
        confidence_threshold: Below this → needs_review.
    """
    print(f"=== classify_work_orders_ai started (threshold={confidence_threshold}) ===")

    api_key = wmill.get_variable("f/service_billing/ANTHROPIC_API_KEY")
    conn = get_db_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Find WOs to classify: awaiting_invoice with cached invoice
    sql = """
        SELECT w.wo_number, w.type, w.template, w.customer, w.total_due,
               w.work_description, w.corrective_action, w.assigned_to,
               w.invoice_number, w.office_name, w.sub_total,
               i.qbo_customer_id
        FROM public.work_orders w
        JOIN billing.invoices i ON i.doc_number = w.invoice_number
        WHERE w.billing_status = 'awaiting_invoice'
        ORDER BY w.completed DESC NULLS LAST
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    cur.execute(sql)
    wos = [dict(r) for r in cur.fetchall()]
    cur.close()

    print(f"Found {len(wos)} WOs to classify")
    if not wos:
        conn.close()
        return {"status": "nothing_to_classify", "classified": 0}

    stats = {"auto_applied": 0, "needs_review": 0, "errors": 0}
    results = []

    for i, wo in enumerate(wos):
        wo_number = wo["wo_number"]

        # Resolve technician → employee → office (mechanical)
        if wo.get("assigned_to"):
            cur2 = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur2.execute("""
                SELECT e.id, b.name AS branch_name
                FROM public.employees e
                LEFT JOIN public.branches b ON b.id = e.branch_id
                WHERE %s = ANY(e.ion_username)
                LIMIT 1
            """, (wo["assigned_to"],))
            emp = cur2.fetchone()
            cur2.close()
            if emp:
                conn.cursor().execute(
                    "UPDATE public.work_orders SET employee_id = %s WHERE wo_number = %s",
                    (emp["id"], wo_number)
                )
                conn.commit()

        # AI classification
        result = classify_with_claude(wo, api_key)

        if "error" in result:
            print(f"  [{i+1}] {wo_number}: ERROR — {result['error']}")
            stats["errors"] += 1
            results.append({"wo_number": wo_number, "error": result["error"]})
            continue

        confidence = result.get("confidence", 0)
        service_category = result.get("service_category")
        qbo_class = result.get("qbo_class")
        reasoning = result.get("reasoning", "")

        cur3 = conn.cursor()

        if confidence >= confidence_threshold and service_category:
            # Auto-apply classification
            cur3.execute("""
                UPDATE public.work_orders
                SET service_category = %s, qbo_class = %s,
                    classification_confidence = %s, classification_model = 'claude-sonnet-4-20250514',
                    last_classified_at = now()
                WHERE wo_number = %s
            """, (service_category, qbo_class, confidence, wo_number))
            conn.commit()
            cur3.close()

            # Run validation (subtotal, credits, payment method, final status)
            cur4 = conn.cursor()
            cur4.execute("SELECT billing.fn_validate_and_advance(%s)", (wo_number,))
            validation = cur4.fetchone()[0]
            conn.commit()
            cur4.close()

            final_status = validation.get("status", "ready_to_process") if isinstance(validation, dict) else "ready_to_process"
            stats["auto_applied"] += 1
            print(f"  [{i+1}] {wo_number}: {service_category}/{qbo_class} ({confidence:.0%}) → {final_status}")
        else:
            # Low confidence → needs_review
            cur3.execute("""
                UPDATE public.work_orders
                SET service_category = %s, qbo_class = %s,
                    classification_confidence = %s, classification_model = 'claude-sonnet-4-20250514',
                    billing_status = 'needs_review',
                    needs_review_reason = %s,
                    billing_status_set_at = now(), last_classified_at = now()
                WHERE wo_number = %s
            """, (
                service_category, qbo_class, confidence,
                f"Low confidence ({confidence:.0%}): {reasoning}",
                wo_number
            ))
            conn.commit()
            cur3.close()
            stats["needs_review"] += 1
            print(f"  [{i+1}] {wo_number}: {service_category}/{qbo_class} ({confidence:.0%}) → needs_review: {reasoning}")

        results.append({
            "wo_number": wo_number,
            "service_category": service_category,
            "qbo_class": qbo_class,
            "confidence": confidence,
            "reasoning": reasoning,
        })

        if (i + 1) % 20 == 0:
            print(f"  ... {i+1}/{len(wos)} classified")

    conn.close()
    print(f"=== done: {stats} ===")
    return {"status": "success", "total": len(wos), "stats": stats, "sample": results[:10]}
