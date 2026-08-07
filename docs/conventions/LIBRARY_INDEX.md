# Shared library index — what workflows compose from

> Status: [active]
> Generated from `f/billing/_lib/*.py`. Every public function, its signature,
> and what it is for. The method that produced this shape is
> [LIBRARY_COMPOSITION.md](LIBRARY_COMPOSITION.md); the contracts are
> [ADR 009](../adrs/009-shared-qbo-primitives-lib.md). This file is the
> inventory those two assume — build a workflow by picking verbs from here
> rather than writing new ones.

Regenerate after adding or renaming a public function:

```bash
python3 scripts/gen_library_index.py
```

## `cache`

f/billing/_lib/cache — verified-echo writes onto billing.invoices (ADR 009 §C)

| Function | Purpose |
|---|---|
| `invoice_subtotal(inv)` | Subtotal from a QBO Invoice payload: the SubTotalLineDetail line, else TotalAmt minus tax |
| `echo_invoice(conn, qbo_invoice_id, qbo_invoice)` | Full-snapshot echo of a freshly READ QBO invoice (balance, email status, raw) |
| `echo_balance(conn, qbo_invoice_id, balance)` | Echo of a balance QBO reported on a confirming read |
| `mark_emailed(conn, qbo_invoice_id)` | One-column echo of a send we performed and QBO acknowledged |
| `echo_payment(conn, payment_body)` | Write-time echo of a QBO Payment WE just wrote (create or apply) — the write RESPONSE carries the full post-write body, so this is a verified echo at zero extra API cost |

## `calc`

f/billing/_lib/calc — pure billing policy

| Function | Purpose |
|---|---|
| `derive_qbo_class(assigned_to, wo_type, description)` | QBO class from the work order's own fields |
| `credit_match_reason(credit, wo_number, invoice_balance)` | Why this credit belongs to this invoice — or None |
| `compose_memo(wo_number, memo_text, is_locked_source)` | A locked memo is preserved verbatim (it was prefixed when first written); a new memo gets the WO prefix |
| `enrichment_updates(memo, qbo_class, class_id, wo_completed, current_txn_date)` | The QBO sparse-PATCH body for an enrichment write |

## `clients`

f/billing/_lib/clients — our API to every external system

| Function | Purpose |
|---|---|
| `QboClient.get_invoice(invoice_id)` | Full invoice read |
| `QboClient.invoice_details(invoice_id)` | {balance, email_status} or None |
| `QboClient.update_invoice(invoice_id, updates)` | Sparse PATCH with SyncToken CAS |
| `QboClient.send_invoice(invoice_id, customer_id)` | Email the invoice |
| `QboClient.bump_due_date(invoice_id)` | — |
| `QboClient.create_payment(customer_id, amount, charge, lines)` | — |
| `QboClient.send_receipt(payment_id, email)` | — |
| `QboClient.apply_credit(credit_id, credit_type, invoice_id, customer_id, amount)` | — |
| `QboClient.customer_email(customer_id)` | — |
| `QboClient.classes()` | name-lower -> ClassRef id |
| `QboClient.class_id(class_name)` | — |

## `credits`

f/billing/_lib/credits — open credits, and applying one

| Function | Purpose |
|---|---|
| `open_for(conn, customer_id, **selectors)` | Open (unapplied) credits for a customer, oldest first |
| `apply(conn, qbo, credit, invoice, reason)` | Apply ONE credit to ONE invoice |

## `customers`

f/billing/_lib/customers — what we know about a customer

| Function | Purpose |
|---|---|
| `payment_route(conn, qbo, qbo_customer_id, wo_text)` | How this customer pays |

## `db`

f/billing/_lib/db — the one Supabase connection helper

| Function | Purpose |
|---|---|
| `get_db_conn()` | — |
| `query_one(conn, sql, params)` | One row as a dict, or None |
| `query_all(conn, sql, params)` | All rows as dicts |
| `execute(conn, sql, params)` | Execute WITHOUT committing — the caller owns the transaction boundary |
| `execute_sql(conn, sql, params)` | Execute + commit — a self-contained write with nothing to be atomic with |
| `dumps(obj)` | THE JSON encoder for DB payloads (Decimal / date / datetime / UUID) |

## `decisions`

f/billing/_lib/decisions — credit decision facts

| Function | Purpose |
|---|---|
| `record_applied(conn, qbo_invoice_id, credit_id, amount, reason)` | — |

## `delivery`

f/billing/_lib/delivery — the shared document-delivery service

| Function | Purpose |
|---|---|
| `deliver_invoice(conn, invoice_id, email, email_status, access_token, realm_id, resend)` | Email the customer their invoice copy, idempotently, and record the emailed fact |
| `send_and_record(conn, invoice_row, balance, stage, access_token, realm_id)` | The WORKFLOW send: WAL-book an attempt, remedy a past-due first send by bumping the due date (we have the primitive; refusing was the pre-bump rule), send with retries, emit invoice_emailed, echo the mirror |

## `events`

f/billing/_lib/events — append_event/emit, the single writer to billing.events

| Function | Purpose |
|---|---|
| `append_event(conn, aggregate, aggregate_id, type, payload, actor, participants, occurred_at)` | INSERT one immutable fact; returns the assigned seq |
| `emit(conn, aggregate, aggregate_id, type, **kw)` | Best-effort append_event for the money path: warn-and-continue on any failure |

## `invoices`

f/billing/_lib/invoices — the invoice aggregate's fact writers

| Function | Purpose |
|---|---|
| `load(conn, qbo_invoice_id)` | The invoice joined to its work order — the shape every billing sentence needs |
| `write_enrichment(conn, qbo_invoice_id)` | The enrichment result — route, class, memo — plus the attempt stamp |

## `payment_methods`

f/billing/_lib/payment_methods — the customer's wallet

| Function | Purpose |
|---|---|
| `fetch(qbo_customer_id, access_token)` | Cards + verified bank accounts for one customer, straight from QBO |
| `is_stale(conn, qbo_customer_id, max_age_minutes)` | — |
| `replace(conn, qbo_customer_id, methods)` | Converge the cache to exactly what QBO returned |
| `refresh(conn, qbo_customer_id, access_token, max_age_minutes)` | Converge the wallet before anyone routes off it |

## `payments`

f/billing/_lib/payments — the shared payment service (ADR 009 §B)

| Function | Purpose |
|---|---|
| `stored_group_lines(attempt)` | [[qbo_invoice_id, amount], ...] persisted on a multi-line anchor attempt, or None |
| `charge_status(cr)` | Our status for a charge result |
| `charge_and_record(conn, intent, access_token, realm_id, dry_run)` | The payment port |
| `recover_orphan(conn, qbo_invoice_id, stage, customer_id, payment_ref, memo_prefix, access_token, realm_id)` | Human-verified orphan recovery: retry ONLY record_qbo_payment with the attempt's persisted charge — NEVER charges again |
| `resolve_payment_method(conn, customer_id, preferred_type, cpm_id)` | Pick the instrument to charge, from the DB cache (refreshed 4h by pull_customer_payment_methods; the row links processing_attempts back to the exact card charged) |
| `load_applicable_credits(conn, qbo_customer_id, memo_match, memo_exclude, ref_match, max_age_months)` | Unapplied credits selected by DATA, not domain knowledge: the caller says what it's looking for (memo_match='maint' for maintenance, ref_match=<wo_number> for a work order) or what to skip (memo_exclude='maint', the service-billing default) |
| `apply_credits(conn, customer_id, invoice_id, access_token, realm_id, credits, memo_match, memo_exclude, ref_match, applied_via, dry_run)` | Apply credits to ONE invoice, each capped at the invoice's remaining fresh balance |

## `qbo`

f/billing/_lib/qbo — shared QuickBooks Online / Intuit Payments primitives

| Function | Purpose |
|---|---|
| `set_rate_limiter(conn)` | Arm the per-system token bucket with this job's DB connection |
| `refresh_qbo_token()` | — |
| `qbo_get(path, access_token, realm_id, params)` | — |
| `qbo_post(path, access_token, realm_id, body)` | — |
| `fetch_qbo_invoice(qbo_invoice_id, access_token, realm_id, conn)` | THE invoice reader: (Invoice dict, None) or (None, error) |
| `fetch_qbo_customer_email(customer_id, access_token, realm_id)` | — |
| `extract_charge_error(resp, body)` | — |
| `charge_card(card_id, amount, request_id, invoice_num, customer_name, access_token)` | — |
| `charge_bank_account(bank_id, amount, request_id, invoice_num, customer_name, access_token)` | — |
| `get_qbo_invoice_details(invoice_id, realm_id, access_token, conn)` | {balance, email_status} view over fetch_qbo_invoice (ONE reader, one echo/audit chokepoint), or None on ANY failure — caller MUST halt on None; never fall back to the cache for a charge decision |
| `build_payment_note(memo_prefix, charge_result)` | PrivateNote for a recorded payment: caller's policy prefix (e.g |
| `record_qbo_payment(customer_id, amount, charge_result, payment_ref, memo_prefix, access_token, realm_id, lines)` | QBO Payment linked to the invoice(s), CCTransId = charge id |
| `send_receipt(payment_id, email, access_token, realm_id)` | Email a QBO Payment receipt (one call) |
| `send_invoice(invoice_id, email, access_token, realm_id)` | Email a QBO invoice copy (one call) |
| `send_receipt_then_invoice(payment_id, invoice_id, email, access_token, realm_id, invoice)` | COMPOSITION over the two primitives above — kept so callers with the common both-sends case stay one line (same return shape as before) |
| `send_invoice_email(invoice_id, customer_id, access_token, realm_id)` | POST /invoice/{id}/send to the customer's QBO primary email |
| `send_payment_receipt(payment_id, customer_id, access_token, realm_id)` | Receipt to the customer's QBO primary email (fetches it first) |
| `update_invoice_sparse(qbo_invoice_id, updates, access_token, realm_id, max_retries, conn, intent_ref, actor)` | Sparse-PATCH an invoice with SyncToken CAS: fetch fresh, send the cached token, retry on Stale Object (someone else won the race) |
| `fetch_qbo_classes(access_token, realm_id)` | The Class catalog (name-lower -> id), for translating a derived class name into the ClassRef id a PATCH wants |
| `apply_credit(credit_id, credit_type, invoice_id, customer_ref, amount, access_token, realm_id)` | Apply ONE existing credit to ONE invoice |
| `bump_invoice_due_date_to_today(invoice_id, access_token, realm_id, max_retries, conn)` | Move the invoice's DueDate to today so a long-parked invoice doesn't arrive showing OVERDUE in the QBO portal |

## `wal`

f/billing/_lib/wal — the shared write-ahead log over
billing.processing_attempts

| Function | Purpose |
|---|---|
| `json_default(o)` | json.dumps default for DB-row types (Decimal / date / datetime / UUID) |
| `dumps(obj)` | json.dumps that handles billing.* row values |
| `latest_attempt(conn, qbo_invoice_id, stage)` | Most recent NON-dry-run CHARGE attempt for this invoice at this stage (excludes `channel='email'` — sends are not charges) |
| `create_attempt(conn, qbo_invoice_id, stage, invoice_number, channel, charge_amount, dry_run, cpm_id, wo_number, payment_method, status)` | WRITE-AHEAD: insert + COMMIT the attempt with a fresh idempotency_key BEFORE any external call |
| `update_attempt(conn, attempt_id, **fields)` | Set columns on one attempt row + commit |
| `insert_webhook_expectation(conn, entity_type, entity_id)` | Record that QBO should send a webhook for this entity within the grace window |
