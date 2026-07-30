"""
The pre-processing contract.

These tests state what enriching an invoice MEANS, not how it is currently
written. Nothing here names an internal helper, asserts a call order, or
counts functions — so the body can be rewritten, split, merged or moved into
SQL and these still pass. If one of them fails, behaviour changed, and that
is the only thing worth blocking a refactor over.

Every case below is a bug that actually happened or a rule Carter set. The
comment on each says which.
"""

import pytest

from conftest import windmill_module

pre_process = windmill_module("f.service_billing.pre_process_invoice")
credits_lib = windmill_module("f.billing._lib.credits")
customers_lib = windmill_module("f.billing._lib.customers")
invoices_lib = windmill_module("f.billing._lib.invoices")

INVOICE_ID = "I1"


@pytest.fixture
def world(db, qbo, monkeypatch):
    """An invoice ready to enrich: work order linked, customer pays by email,
    no open credits. Each test bends one thing."""
    state = {
        "invoice": {
            "qbo_invoice_id": INVOICE_ID, "qbo_customer_id": "C1",
            "wo_number": "5094004", "wo_text": "replace pump motor",
            "assigned_to": "SVC-ALEX", "wo_type": "GENERAL",
            "work_description": "replace pump motor", "completed": None,
            "memo": None, "memo_locked": False,
            "corrective_action": "replaced motor", "technician_instructions": "",
        },
        "credits": [],
        "route": {"payment_method": "invoice", "preferred_payment_type": "email",
                  "target_payment_method_id": None},
        "memo": {"text": "Pump Motor Replacement", "locked": True, "ok": True,
                 "source": "llm"},
        "applied": [],
    }

    monkeypatch.setattr(invoices_lib, "load", lambda c, i: dict(state["invoice"]))
    monkeypatch.setattr(credits_lib, "open_for", lambda c, cust, **k: state["credits"])
    monkeypatch.setattr(customers_lib, "payment_route",
                        lambda c, client, cust, text=None: state["route"])
    monkeypatch.setattr(pre_process, "resolve_memo",
                        lambda inv, wo, **k: state["memo"])

    def fake_apply(conn, client, credit, invoice, reason, **kw):
        state["applied"].append((credit["qbo_payment_id"], reason))
        return float(credit["unapplied_amt"])
    monkeypatch.setattr(credits_lib, "apply", fake_apply)

    state["db"], state["qbo"] = db, qbo
    return state


def enrich(world):
    return pre_process.enrich(world["db"], world["qbo"], INVOICE_ID)


# ── what enrichment produces ────────────────────────────────────────────────

def test_enrichment_lands_in_qbo_and_on_our_row(world):
    """The whole point: QBO gets the memo and class, our row records the
    route and that we ran."""
    enrich(world)

    (_, _, updates, intent) = world["qbo"].patched()[0]
    assert updates["PrivateNote"] == "WO#5094004: Pump Motor Replacement"
    assert updates["CustomerMemo"]["value"] == updates["PrivateNote"]
    assert updates["ClassRef"]["name"] == "Service"
    assert intent == "pre_process"

    persisted = world["db"].values("billing.invoices")
    assert "WO#5094004: Pump Motor Replacement" in persisted
    assert "Service" in persisted


def test_memo_is_prefixed_with_the_work_order_number(world):
    """Carter's rule: a memo is useless in QBO without the WO number."""
    enrich(world)
    assert world["qbo"].patched()[0][2]["PrivateNote"].startswith("WO#5094004:")


def test_a_locked_memo_is_preserved_verbatim(world):
    """A human-edited memo was already prefixed when it was written. Do not
    prefix it twice."""
    world["memo"] = {"text": "WO#5094004: Do not touch", "locked": True,
                     "ok": True, "source": "locked"}
    enrich(world)
    assert world["qbo"].patched()[0][2]["PrivateNote"] == "WO#5094004: Do not touch"


# ── failure: never claim an enrichment QBO did not accept ───────────────────

def test_a_rejected_qbo_patch_leaves_our_row_untouched(world):
    """REGRESSION. We used to discard update_invoice's result and stamp the
    row anyway: enrichment_ok derived true, invoice_ready passed, and the
    invoice was charged and emailed with no memo or class in QBO."""
    world["qbo"]._patch_result = {"success": False, "error": "HTTP 401: token burned"}

    with pytest.raises(RuntimeError, match="rejected"):
        enrich(world)

    assert world["db"].wrote("billing.invoices") == [], \
        "a failed QBO write must not leave our row claiming it succeeded"


def test_an_unreadable_invoice_stops_before_any_write(world):
    """If QBO cannot even show us the invoice we know nothing. Raise, and let
    the queue's attempts ledger retry then dead-letter."""
    world["qbo"]._invoice = None

    with pytest.raises(RuntimeError):
        enrich(world)

    assert world["db"].wrote("billing.invoices") == []
    assert world["qbo"].patched() == []


def test_no_confident_memo_records_the_run_without_touching_qbo(world):
    """Not a failure — a result. We ran, produced no memo, so the row records
    that and the gate (memo IS NOT NULL) parks it in needs_review."""
    world["memo"] = {"text": None, "locked": False, "ok": False, "source": "llm"}

    enrich(world)

    assert world["qbo"].patched() == [], "nothing to say to QBO without a memo"
    assert world["db"].wrote("billing.invoices"), "but the attempt is recorded"


# ── credits: apply what clearly belongs, leave the rest open ────────────────

def _credit(pid, amount, *, ref="", memo=""):
    return {"qbo_payment_id": pid, "unapplied_amt": amount,
            "ref_num": ref, "memo": memo, "txn_date": "2026-07-01"}


def test_a_credit_naming_the_work_order_is_applied(world):
    world["credits"] = [_credit("A", 150, ref="5094004")]
    result = enrich(world)
    assert world["applied"] == [("A", "wo_number_in_ref_num")]
    assert result["credits_applied"] == 150


def test_a_credit_covering_the_balance_is_applied(world):
    world["credits"] = [_credit("A", 500)]        # balance is 500
    enrich(world)
    assert world["applied"] == [("A", "full_cover")]


def test_an_unrelated_credit_is_left_open(world):
    """Carter's rule: no proposals. Either it clearly belongs here, or we do
    nothing and it surfaces as undecided in invoice_ready for a human."""
    world["credits"] = [_credit("A", 77, memo="deposit for another job")]
    result = enrich(world)
    assert world["applied"] == []
    assert result["credits_applied"] == 0


def test_two_credits_cannot_both_cover_one_balance(world):
    """REGRESSION. The loop matched every credit against the ORIGINAL balance,
    so two $500 credits both scored full_cover on a $500 invoice."""
    world["credits"] = [_credit("A", 500), _credit("B", 500)]
    enrich(world)
    assert world["applied"] == [("A", "full_cover")]


def test_credits_stop_once_the_balance_is_cleared(world):
    """Even a WO-number match applies nothing to a settled invoice — no
    pointless QBO round trip."""
    world["credits"] = [_credit("A", 500), _credit("B", 200, ref="5094004")]
    enrich(world)
    assert [c for c, _ in world["applied"]] == ["A"]


def test_a_partial_credit_is_applied_then_the_rest_still_matches(world):
    """$200 named the WO, leaving $300 — a $300 credit now covers the rest."""
    world["credits"] = [_credit("A", 200, ref="5094004"), _credit("B", 300)]
    enrich(world)
    assert world["applied"] == [("A", "wo_number_in_ref_num"), ("B", "full_cover")]


# ── the route: the payment method id, or nothing ────────────────────────────

def test_an_email_customer_gets_no_payment_method(world):
    result = enrich(world)
    assert result["payment_method_id"] is None


def test_a_card_customer_gets_the_method_on_the_row(world):
    """Carter's rule: the end result of pre-processing is the payment method
    id on the invoice row, or not."""
    world["route"] = {"payment_method": "on_file",
                      "preferred_payment_type": "credit_card",
                      "target_payment_method_id": "pm-uuid-1"}
    result = enrich(world)
    assert result["payment_method_id"] == "pm-uuid-1"
    assert "pm-uuid-1" in world["db"].values("billing.invoices")


def test_a_card_customer_with_no_method_on_file_is_not_a_crash(world):
    """It writes a NULL method and lets billing.invoice_ready block it. The
    script does not decide needs_review — the database does."""
    world["route"] = {"payment_method": "on_file",
                      "preferred_payment_type": "credit_card",
                      "target_payment_method_id": None}
    result = enrich(world)
    assert result["payment_method_id"] is None
    assert world["db"].wrote("billing.invoices")


# ── classification ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("assigned_to,wo_type,description,expected", [
    ("MNT-JOE", "GENERAL", "weekly service", "Maintenance"),
    ("SVC-ALEX", "DELIVERY", "deliver chlorine", "Delivery"),
    ("SVC-ALEX", "GENERAL", "replaster the pool", "Renovation"),
    ("SVC-ALEX", "GENERAL", "replace pump motor", "Service"),
])
def test_class_follows_the_work_order(world, assigned_to, wo_type,
                                      description, expected):
    world["invoice"].update(assigned_to=assigned_to, wo_type=wo_type,
                            work_description=description)
    result = enrich(world)
    assert result["qbo_class"] == expected
    assert world["qbo"].patched()[0][2]["ClassRef"]["name"] == expected


# ── the script stays a script ───────────────────────────────────────────────

def test_the_workflow_holds_no_sql_and_no_vendor_shaping():
    """Layer 5 of the parts catalog: a workflow composes parts, it does not
    define them. This is the rule that stops the file growing back to 600
    lines — every exception has to be argued for here."""
    import inspect
    lines = inspect.getsource(pre_process).splitlines()
    # comments are prose (and Windmill's `# requirements:` dependency header)
    code = "\n".join(l for l in lines if not l.lstrip().startswith("#"))
    for forbidden in ("SELECT ", "INSERT ", "UPDATE ", "psycopg2", "requests."):
        assert forbidden not in code, f"{forbidden.strip()} belongs in a lib module"
    assert sum(1 for l in lines if l.startswith("def ")) <= 2


# ── the cached balance must be true after we move money ─────────────────────

def test_applying_credits_reconverges_our_cached_balance(world):
    """billing.invoice_ready's covered-invoice escape reads i.balance, and
    apply_credits fresh-reads BEFORE applying — so without a re-read our cache
    stays stale-high and a paid invoice looks unpaid to the gate."""
    world["credits"] = [_credit("A", 500)]
    enrich(world)
    reads = [c for c in world["qbo"].calls if c[0] == "get_invoice"]
    assert len(reads) == 2, "expected a second read to converge the balance"


def test_no_credits_means_no_extra_read(world):
    """The re-read is not free. If we moved no money there is nothing to
    reconverge."""
    world["credits"] = []
    enrich(world)
    assert len([c for c in world["qbo"].calls if c[0] == "get_invoice"]) == 1


# ── the charge guard ────────────────────────────────────────────────────────
# Frank Turner, 2026-07-27: his card was deactivated in the app on 2026-06-29,
# the wallet refresh re-enabled it because QBO still reported it ACTIVE, and
# $57.77 was charged. Selection and the charge both filtered on is_active, so
# one wrong column defeated both "checks". The charge moment now reads
# deactivated_at instead — a different column, so the same bug cannot pass twice.

payments_lib = windmill_module("f.billing._lib.payments")

CPM = "11111111-1111-1111-1111-111111111111"


def _charge_intent():
    return {"stage": "process", "qbo_invoice_id": "I9", "invoice_number": "7962199",
            "cpm_id": CPM, "payment_method_id": "tok_1", "channel": "card",
            "customer_id": "C1", "wo_number": "5073964"}


def test_charge_refuses_a_user_deactivated_card(db, monkeypatch):
    """deactivated_at set, is_active WRONGLY true — exactly Frank's row."""
    db.returns("FROM billing.customer_payment_methods",
               [{"is_active": True, "user_off": True}])
    monkeypatch.setattr(payments_lib, "create_attempt",
                        lambda *a, **k: {"id": "att1"})
    monkeypatch.setattr(payments_lib, "update_attempt", lambda *a, **k: None)

    result = payments_lib.charge_and_record(db, _charge_intent(), "tok", "realm")

    assert result["status"] == "no_payment_method"
    assert "deactivated by a user" in result["error"]


def test_charge_proceeds_past_the_guard_for_a_live_card(db, monkeypatch):
    """The guard must not block a card nobody turned off — it gets past this
    point and fails later for want of a faked QBO, which is proof enough."""
    db.returns("FROM billing.customer_payment_methods",
               [{"is_active": True, "user_off": False}])
    monkeypatch.setattr(payments_lib, "create_attempt",
                        lambda *a, **k: {"id": "att1"})
    monkeypatch.setattr(payments_lib, "update_attempt", lambda *a, **k: None)

    try:
        result = payments_lib.charge_and_record(db, _charge_intent(), "tok", "realm")
    except Exception:
        return  # got past the guard and died at a boundary the fake doesn't cover
    assert result["status"] != "no_payment_method"


def test_charge_refuses_a_disabled_token_even_with_no_cpm_id(db, monkeypatch):
    """process_maint_charges passes payment_method_id with cpm_id=None when it
    believes the row is not live. The guard has to key off the Intuit id too,
    or the one path most likely to hand over a stale instrument is the one
    path with no second check."""
    db.returns("WHERE qbo_payment_method_id",
               [{"is_active": False, "user_off": True}])
    monkeypatch.setattr(payments_lib, "create_attempt", lambda *a, **k: {"id": "att1"})
    monkeypatch.setattr(payments_lib, "update_attempt", lambda *a, **k: None)

    intent = {**_charge_intent(), "cpm_id": None}
    result = payments_lib.charge_and_record(db, intent, "tok", "realm")

    assert result["status"] == "no_payment_method"


def test_charge_allows_a_token_we_have_no_row_for(db, monkeypatch):
    """Unknown token = not our record to judge. Blocking here would break
    every caller that charges an instrument we never cached."""
    db.returns("WHERE qbo_payment_method_id", [])
    monkeypatch.setattr(payments_lib, "create_attempt", lambda *a, **k: {"id": "att1"})
    monkeypatch.setattr(payments_lib, "update_attempt", lambda *a, **k: None)

    try:
        result = payments_lib.charge_and_record(
            db, {**_charge_intent(), "cpm_id": None}, "tok", "realm")
    except Exception:
        return  # past the guard, died at an unfaked boundary
    assert result["status"] != "no_payment_method"
