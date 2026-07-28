"""
Make Windmill scripts importable and testable on a laptop.

Windmill scripts import each other by absolute workspace path
(`from f.billing._lib.db import ...`) and run in an image that has psycopg2,
wmill and requests. None of that is true here, so this shim:

  1. registers the `f.*` package tree so those imports resolve to repo files
  2. stubs the three runtime modules that only exist on the platform
  3. hands tests two boundary fakes — a database and a QBO client

Fakes sit at the BOUNDARY (a connection, an HTTP client), never at our own
function names. That is deliberate: a test that patches `write_enrichment`
breaks the moment you rename it, which would make the suite an obstacle to
refactoring rather than a licence for it. These fakes only know what leaves
the process.
"""

import importlib.util
import sys
import types
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


# ── 1 + 2. the platform shim ────────────────────────────────────────────────

def _stub_runtime():
    psycopg2 = types.ModuleType("psycopg2")
    extras = types.ModuleType("psycopg2.extras")
    extras.RealDictCursor = object
    psycopg2.extras = extras
    psycopg2.Error = Exception
    sys.modules.setdefault("psycopg2", psycopg2)
    sys.modules.setdefault("psycopg2.extras", extras)

    wmill = types.ModuleType("wmill")
    wmill.get_variable = lambda key: f"stub:{key}"
    wmill.get_resource = lambda key: {}
    sys.modules.setdefault("wmill", wmill)

    requests = types.ModuleType("requests")
    def _no_network(*a, **k):
        raise AssertionError("a test made a real HTTP call — fake the client")
    requests.get = requests.post = requests.put = _no_network
    sys.modules.setdefault("requests", requests)


def _register_packages():
    for name in ("f", "f.billing", "f.billing._lib", "f.service_billing",
                 "f.ION", "f.maintenance"):
        if name not in sys.modules:
            pkg = types.ModuleType(name)
            pkg.__path__ = [str(REPO / name.replace(".", "/"))]
            sys.modules[name] = pkg


def windmill_module(dotted_path):
    """Import a Windmill script by its workspace path, e.g.
    `f.service_billing.pre_process_invoice`."""
    if dotted_path in sys.modules and hasattr(sys.modules[dotted_path], "__file__"):
        return sys.modules[dotted_path]
    path = REPO / (dotted_path.replace(".", "/") + ".py")
    spec = importlib.util.spec_from_file_location(dotted_path, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[dotted_path] = module
    spec.loader.exec_module(module)
    return module


_stub_runtime()
_register_packages()


# ── 3. boundary fakes ───────────────────────────────────────────────────────

class FakeCursor:
    def __init__(self, db, cursor_factory=None):
        self.db = db
        self._result = None

    def execute(self, sql, params=()):
        self.db.statements.append((" ".join(sql.split()), tuple(params or ())))
        self._result = self.db._answer(sql, params)

    def fetchone(self):
        rows = self._result or []
        return dict(rows[0]) if rows else None

    def fetchall(self):
        return [dict(r) for r in (self._result or [])]

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


class FakeDb:
    """Records every statement; answers reads from patterns a test registers.

    Assertions go through `wrote(table)` / `values(table)` rather than exact
    SQL text, so rewriting a query does not break a test — only changing what
    the code actually persists does.
    """

    def __init__(self):
        self.statements = []
        self.answers = []          # (substring, rows)
        self.commits = 0
        self.rollbacks = 0

    def returns(self, sql_contains, rows):
        """Next read whose SQL contains this substring answers with `rows`."""
        self.answers.append((sql_contains, rows))
        return self

    def _answer(self, sql, params):
        flat = " ".join(sql.split())
        for needle, rows in self.answers:
            if needle in flat:
                return rows
        return []

    # -- psycopg2 connection surface
    def cursor(self, cursor_factory=None):
        return FakeCursor(self, cursor_factory)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        pass

    # -- assertions
    def wrote(self, table):
        """Every write statement that touched `table`."""
        return [(sql, params) for sql, params in self.statements
                if table in sql and sql.split()[0].upper()
                in ("UPDATE", "INSERT", "DELETE")]

    def values(self, table):
        """Flattened parameters of every write to `table` — assert on what
        was persisted without pinning column order or query text."""
        return [v for _, params in self.wrote(table) for v in params]


class FakeQbo:
    """Stands in for QboClient. Records calls; behaviour is set per test."""

    def __init__(self, invoice=None, patch_result=None, class_ids=None):
        self.access_token, self.realm_id = "tok", "realm"
        self._invoice = invoice if invoice is not None else {
            "Id": "I1", "Balance": 500.0, "TotalAmt": 500.0,
            "TxnDate": "2026-07-01", "SyncToken": "3",
            "CustomerRef": {"value": "C1"}}
        self._patch_result = patch_result or {"success": True, "invoice": {"Id": "I1"}}
        self._class_ids = class_ids or {"Service": "7", "Maintenance": "8",
                                        "Delivery": "9", "Renovation": "10"}
        self.calls = []

    def get_invoice(self, invoice_id):
        self.calls.append(("get_invoice", invoice_id))
        return self._invoice

    def class_id(self, name):
        return self._class_ids.get(name)

    def update_invoice(self, invoice_id, updates, *, intent_ref):
        self.calls.append(("update_invoice", invoice_id, updates, intent_ref))
        return self._patch_result

    def patched(self):
        return [c for c in self.calls if c[0] == "update_invoice"]


@pytest.fixture
def db():
    return FakeDb()


@pytest.fixture
def qbo():
    return FakeQbo()
