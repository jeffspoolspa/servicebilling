"""
Every _lib module's self-check, run locally.

These already existed — each module's `main()` is a pure, dependency-free
assertion suite that until now only ran when you invoked the script on
Windmill. This drags all of them into one `pytest` run so a laptop can prove
the parts before anything deploys.

Adding a module here is deliberate: if a new `_lib` module has no `main()`
self-check, this file is where that shows up as a missing entry.
"""

import pytest

from conftest import windmill_module

SELF_CHECKED = [
    "f.billing._lib.calc",
    "f.billing._lib.cache",
    "f.billing._lib.clients",
    "f.billing._lib.events",
    "f.billing._lib.payment_methods",
    "f.billing._lib.payments",
    "f.billing._lib.qbo",
    "f.billing._lib.wal",
    "f.service_billing.memo",
]


@pytest.mark.parametrize("dotted", SELF_CHECKED)
def test_module_selfcheck(dotted, capsys):
    result = windmill_module(dotted).main()
    capsys.readouterr()
    assert result["ok"], (
        f"{dotted}: {result['passed']}/{result['total']} — "
        f"failed: {result.get('failed')}")


def test_every_lib_module_is_self_checked():
    """A part with no self-check is a part nobody can trust. `db` and the
    repository modules are exempt: they are thin SQL wrappers whose behaviour
    is proved by the contract tests, not in isolation."""
    from pathlib import Path
    exempt = {"__init__", "db", "invoices", "decisions", "credits",
              "customers", "delivery"}
    lib = Path(__file__).resolve().parent.parent / "f/billing/_lib"
    on_disk = {p.stem for p in lib.glob("*.py")} - exempt
    covered = {d.rsplit(".", 1)[1] for d in SELF_CHECKED}
    assert not (on_disk - covered), (
        f"lib modules with no self-check: {sorted(on_disk - covered)}")
