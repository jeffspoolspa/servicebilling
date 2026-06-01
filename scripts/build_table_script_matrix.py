#!/usr/bin/env python3
"""
Build complete cross-reference matrix between Supabase tables and Windmill scripts.

Outputs (both written to /docs/audits/):
- 2026-05-27-table-script-matrix.md — human-readable report
- table_script_matrix.json — structured data for further analysis

For each script, extracts table references via:
- Supabase SDK patterns: .table('X'), .from_('X'), .schema('Y').table('X')
- Raw SQL: FROM/JOIN/INTO/UPDATE clauses
- Schema-qualified references: schema.table

Then classifies each reference as READ / WRITE / BOTH based on context.
"""
from __future__ import annotations
import json
import re
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# All tables in user schemas (from SQL query, hardcoded so we know what to look for)
# Format: {qualified_name: {schema, table, rows, size, comment}}
CANONICAL_TABLES = [
    {"schema": "app_checks", "table_name": "bank_deposits", "rows": 0, "size": "16 kB", "comment": None},
    {"schema": "app_checks", "table_name": "cash_entries", "rows": 28, "size": "48 kB", "comment": None},
    {"schema": "app_checks", "table_name": "check_invoices", "rows": 5296, "size": "1752 kB", "comment": "Links checks to the QBO invoices they pay"},
    {"schema": "app_checks", "table_name": "check_payments", "rows": 4469, "size": "2232 kB", "comment": None},
    {"schema": "app_checks", "table_name": "customer_aliases", "rows": 0, "size": "32 kB", "comment": "Maps check names to QBO customers for auto-matching"},
    {"schema": "app_checks", "table_name": "deposit_reconciliation", "rows": 155, "size": "184 kB", "comment": None},
    {"schema": "app_checks", "table_name": "deposits", "rows": 515, "size": "1040 kB", "comment": None},
    {"schema": "app_checks", "table_name": "import_staging", "rows": 4292, "size": "3304 kB", "comment": "Temporary staging for historical check import from spreadsheet. Drop after import complete."},
    {"schema": "app_checks", "table_name": "qbo_deposits_cache", "rows": 21758, "size": "8224 kB", "comment": "Temporary cache of QBO Deposit line items for reconciliation matching. Drop after import complete."},
    {"schema": "app_checks", "table_name": "qbo_invoice_lookup", "rows": 19829, "size": "2168 kB", "comment": None},
    {"schema": "app_checks", "table_name": "qbo_payments_cache", "rows": 18636, "size": "47 MB", "comment": "Temporary cache of QBO Payment records for bulk matching. Drop after import complete."},
    {"schema": "app_checks", "table_name": "scanned_checks", "rows": 4524, "size": "3512 kB", "comment": "Check deposits scanned for processing into QBO"},
    {"schema": "billing", "table_name": "autopay_customers", "rows": 262, "size": "192 kB", "comment": "Source of truth for which customers are enrolled in autopay. Replaces Airtable roster."},
    {"schema": "billing", "table_name": "autopay_events", "rows": 4338, "size": "1144 kB", "comment": "Immutable event log for autopay transactions."},
    {"schema": "billing", "table_name": "autopay_transactions", "rows": 715, "size": "624 kB", "comment": "Single source of truth for monthly autopay billing."},
    {"schema": "billing", "table_name": "billing_runs", "rows": 3, "size": "48 kB", "comment": "Master record per monthly billing cycle."},
    {"schema": "billing", "table_name": "cdc_cursors", "rows": 1, "size": "64 kB", "comment": "Per-source watermarks for incremental reconciliation."},
    {"schema": "billing", "table_name": "customer_payment_methods", "rows": 794, "size": "1416 kB", "comment": None},
    {"schema": "billing", "table_name": "customer_payments", "rows": 15996, "size": "35 MB", "comment": None},
    {"schema": "billing", "table_name": "drift_log", "rows": 214997, "size": "61 MB", "comment": "Every cache-vs-QBO mismatch detected by the CDC reconciler."},
    {"schema": "billing", "table_name": "invoice_send_log", "rows": 770, "size": "264 kB", "comment": None},
    {"schema": "billing", "table_name": "invoices", "rows": 2240, "size": "16 MB", "comment": None},
    {"schema": "billing", "table_name": "payment_invoice_links", "rows": 2429, "size": "696 kB", "comment": None},
    {"schema": "billing", "table_name": "processing_attempts", "rows": 613, "size": "864 kB", "comment": None},
    {"schema": "billing", "table_name": "reconciliation_findings", "rows": 0, "size": "40 kB", "comment": None},
    {"schema": "billing", "table_name": "webhook_expectations", "rows": 362, "size": "160 kB", "comment": "Tracks outbound writes that should produce QBO webhooks."},
    {"schema": "billing", "table_name": "webhook_log", "rows": 3923, "size": "1728 kB", "comment": "Audit trail of every QBO webhook arrival."},
    {"schema": "billing_audit", "table_name": "_april_audit_snapshot", "rows": 8, "size": "16 kB", "comment": None},
    {"schema": "billing_audit", "table_name": "chemical_cost_estimates", "rows": 24, "size": "64 kB", "comment": "Pre-computed chemical cost percentiles."},
    {"schema": "billing_audit", "table_name": "consumable_items", "rows": 129, "size": "344 kB", "comment": "Whitelist of consumable/chemical items."},
    {"schema": "billing_audit", "table_name": "maintenance_invoice_line_items", "rows": 48607, "size": "14 MB", "comment": None},
    {"schema": "billing_audit", "table_name": "maintenance_invoices", "rows": 8302, "size": "5856 kB", "comment": None},
    {"schema": "email_extraction", "table_name": "email_attachments", "rows": 60, "size": "1976 kB", "comment": None},
    {"schema": "email_extraction", "table_name": "extraction_results", "rows": 60, "size": "128 kB", "comment": None},
    {"schema": "ion", "table_name": "consumable_aliases", "rows": 0, "size": "24 kB", "comment": None},
    {"schema": "ion", "table_name": "consumable_definitions", "rows": 0, "size": "24 kB", "comment": None},
    {"schema": "ion", "table_name": "extraction_runs", "rows": 0, "size": "16 kB", "comment": None},
    {"schema": "ion", "table_name": "reading_aliases", "rows": 38, "size": "48 kB", "comment": None},
    {"schema": "ion", "table_name": "reading_definitions", "rows": 41, "size": "48 kB", "comment": None},
    {"schema": "ion", "table_name": "service_visits", "rows": 0, "size": "144 kB", "comment": None},
    {"schema": "ion", "table_name": "task_aliases", "rows": 23, "size": "48 kB", "comment": None},
    {"schema": "ion", "table_name": "task_definitions", "rows": 23, "size": "48 kB", "comment": None},
    {"schema": "ion", "table_name": "visit_consumables", "rows": 0, "size": "64 kB", "comment": None},
    {"schema": "ion", "table_name": "visit_readings", "rows": 0, "size": "80 kB", "comment": None},
    {"schema": "ion", "table_name": "visit_tasks", "rows": 0, "size": "64 kB", "comment": None},
    {"schema": "maintenance", "table_name": "chem_readings", "rows": 6179, "size": "1824 kB", "comment": None},
    {"schema": "maintenance", "table_name": "commercial_lead_details", "rows": 0, "size": "32 kB", "comment": None},
    {"schema": "maintenance", "table_name": "consumables_usage", "rows": 5906, "size": "1776 kB", "comment": None},
    {"schema": "maintenance", "table_name": "onboarding", "rows": 0, "size": "48 kB", "comment": None},
    {"schema": "maintenance", "table_name": "residential_lead_details", "rows": 11, "size": "32 kB", "comment": None},
    {"schema": "maintenance", "table_name": "service_bodies", "rows": 13, "size": "48 kB", "comment": None},
    {"schema": "maintenance", "table_name": "task_schedules", "rows": 741, "size": "712 kB", "comment": None},
    {"schema": "maintenance", "table_name": "task_schedules_audit", "rows": 4959, "size": "6144 kB", "comment": None},
    {"schema": "maintenance", "table_name": "tasks", "rows": 469, "size": "560 kB", "comment": None},
    {"schema": "maintenance", "table_name": "tasks_audit", "rows": 3287, "size": "6544 kB", "comment": None},
    {"schema": "maintenance", "table_name": "truck_check_submissions", "rows": 0, "size": "32 kB", "comment": None},
    {"schema": "maintenance", "table_name": "visits", "rows": 5296, "size": "3096 kB", "comment": None},
    {"schema": "public", "table_name": "Customers", "rows": 8877, "size": "7016 kB", "comment": None},
    {"schema": "public", "table_name": "adjustments", "rows": 17563, "size": "6200 kB", "comment": None},
    {"schema": "public", "table_name": "app_config", "rows": 1, "size": "168 kB", "comment": None},
    {"schema": "public", "table_name": "app_roles", "rows": 4, "size": "64 kB", "comment": None},
    {"schema": "public", "table_name": "branch_gbp_links", "rows": 4, "size": "48 kB", "comment": None},
    {"schema": "public", "table_name": "branches", "rows": 4, "size": "64 kB", "comment": None},
    {"schema": "public", "table_name": "campaigns", "rows": 2, "size": "64 kB", "comment": None},
    {"schema": "public", "table_name": "card_charge_attempts", "rows": 1, "size": "56 kB", "comment": "Write-ahead log for card vault charge attempts."},
    {"schema": "public", "table_name": "card_collection_requests", "rows": 53, "size": "80 kB", "comment": None},
    {"schema": "public", "table_name": "card_vault", "rows": 19, "size": "72 kB", "comment": None},
    {"schema": "public", "table_name": "card_vault_access_log", "rows": 26, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "communications", "rows": 4, "size": "88 kB", "comment": None},
    {"schema": "public", "table_name": "consumables_data", "rows": 9685, "size": "2632 kB", "comment": None},
    {"schema": "public", "table_name": "departments", "rows": 5, "size": "48 kB", "comment": None},
    {"schema": "public", "table_name": "email_messages", "rows": 3, "size": "48 kB", "comment": None},
    {"schema": "public", "table_name": "employees", "rows": 113, "size": "200 kB", "comment": None},
    {"schema": "public", "table_name": "eq_category_rules", "rows": 7, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "eq_equipment_events", "rows": 0, "size": "40 kB", "comment": None},
    {"schema": "public", "table_name": "eq_equipment_photos", "rows": 0, "size": "24 kB", "comment": None},
    {"schema": "public", "table_name": "eq_equipment_records", "rows": 0, "size": "56 kB", "comment": None},
    {"schema": "public", "table_name": "eq_equipment_replacements", "rows": 0, "size": "16 kB", "comment": None},
    {"schema": "public", "table_name": "eq_manufacturer_rules", "rows": 7, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "eq_model_family_rules", "rows": 36, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "eq_offline_drafts", "rows": 0, "size": "16 kB", "comment": None},
    {"schema": "public", "table_name": "eq_properties", "rows": 3, "size": "64 kB", "comment": None},
    {"schema": "public", "table_name": "eq_technicians", "rows": 5, "size": "48 kB", "comment": None},
    {"schema": "public", "table_name": "est_emails", "rows": 1876, "size": "11 MB", "comment": None},
    {"schema": "public", "table_name": "estimates", "rows": 932, "size": "18 MB", "comment": None},
    {"schema": "public", "table_name": "interview_submissions", "rows": 10, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "inventory_count_events", "rows": 4, "size": "152 kB", "comment": None},
    {"schema": "public", "table_name": "inventory_count_rows", "rows": 3065, "size": "2784 kB", "comment": None},
    {"schema": "public", "table_name": "inventory_count_schedules", "rows": 0, "size": "24 kB", "comment": None},
    {"schema": "public", "table_name": "inventory_count_sections", "rows": 41, "size": "96 kB", "comment": None},
    {"schema": "public", "table_name": "inventory_count_snapshots", "rows": 2839, "size": "1224 kB", "comment": None},
    {"schema": "public", "table_name": "inventory_movements", "rows": 84808, "size": "45 MB", "comment": None},
    {"schema": "public", "table_name": "inventory_section_items", "rows": 1679, "size": "792 kB", "comment": "Assigns items to sections."},
    {"schema": "public", "table_name": "inventory_sections", "rows": 41, "size": "72 kB", "comment": "Physical sections within a location."},
    {"schema": "public", "table_name": "inventory_sign_outs", "rows": 352, "size": "136 kB", "comment": None},
    {"schema": "public", "table_name": "inventory_starting_zoho", "rows": 3719, "size": "600 kB", "comment": None},
    {"schema": "public", "table_name": "invoice_processing_log", "rows": 545, "size": "336 kB", "comment": "Audit log for automated invoice processing workflow."},
    {"schema": "public", "table_name": "item_categories", "rows": 0, "size": "40 kB", "comment": None},
    {"schema": "public", "table_name": "items", "rows": 6503, "size": "5400 kB", "comment": None},
    {"schema": "public", "table_name": "leads", "rows": 11, "size": "112 kB", "comment": None},
    {"schema": "public", "table_name": "legacy_twilio_text_messages", "rows": 887, "size": "496 kB", "comment": None},
    {"schema": "public", "table_name": "locations", "rows": 27, "size": "80 kB", "comment": None},
    {"schema": "public", "table_name": "pools", "rows": 538, "size": "192 kB", "comment": None},
    {"schema": "public", "table_name": "purchases", "rows": 6888, "size": "3608 kB", "comment": None},
    {"schema": "public", "table_name": "qbo_auth_config", "rows": 1, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "qbo_customer_sync_log", "rows": 105, "size": "64 kB", "comment": None},
    {"schema": "public", "table_name": "qbo_items", "rows": 4429, "size": "1992 kB", "comment": None},
    {"schema": "public", "table_name": "qbo_sales_by_sku", "rows": 40224, "size": "12 MB", "comment": None},
    {"schema": "public", "table_name": "review_bonuses", "rows": 0, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "review_requests", "rows": 125, "size": "160 kB", "comment": None},
    {"schema": "public", "table_name": "review_responses", "rows": 0, "size": "16 kB", "comment": None},
    {"schema": "public", "table_name": "sales", "rows": 37233, "size": "9448 kB", "comment": None},
    {"schema": "public", "table_name": "service_locations", "rows": 8723, "size": "3656 kB", "comment": None},
    {"schema": "public", "table_name": "service_schedules", "rows": 0, "size": "56 kB", "comment": None},
    {"schema": "public", "table_name": "sku_aliases", "rows": 101, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "source_adapters", "rows": 1, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "source_field_mappings", "rows": 43, "size": "64 kB", "comment": None},
    {"schema": "public", "table_name": "spot_check_queue", "rows": 0, "size": "56 kB", "comment": "Items flagged for individual counting."},
    {"schema": "public", "table_name": "staging_opening_stock", "rows": 3719, "size": "304 kB", "comment": None},
    {"schema": "public", "table_name": "switch_to_weekly_campaign", "rows": 114, "size": "72 kB", "comment": "Bi-weekly customers targeted for switch-to-weekly email campaign"},
    {"schema": "public", "table_name": "system_alerts", "rows": 1, "size": "48 kB", "comment": "Outbound alert queue."},
    {"schema": "public", "table_name": "text_messages", "rows": 1, "size": "48 kB", "comment": None},
    {"schema": "public", "table_name": "training_checklist_template_items", "rows": 26, "size": "88 kB", "comment": None},
    {"schema": "public", "table_name": "training_question_bank", "rows": 25, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "training_test_submission_responses", "rows": 0, "size": "48 kB", "comment": None},
    {"schema": "public", "table_name": "training_test_submissions", "rows": 0, "size": "24 kB", "comment": None},
    {"schema": "public", "table_name": "training_tests", "rows": 0, "size": "24 kB", "comment": None},
    {"schema": "public", "table_name": "training_tracker", "rows": 0, "size": "40 kB", "comment": None},
    {"schema": "public", "table_name": "training_tracker_checklist_items", "rows": 0, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "transfers", "rows": 8739, "size": "3064 kB", "comment": None},
    {"schema": "public", "table_name": "vault_config", "rows": 1, "size": "48 kB", "comment": None},
    {"schema": "public", "table_name": "vault_users", "rows": 2, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "vendor_credits", "rows": 14, "size": "128 kB", "comment": None},
    {"schema": "public", "table_name": "vendors", "rows": 4, "size": "32 kB", "comment": None},
    {"schema": "public", "table_name": "voicemail_transcripts", "rows": 113, "size": "360 kB", "comment": None},
    {"schema": "public", "table_name": "work_orders", "rows": 3227, "size": "3896 kB", "comment": None},
    {"schema": "public", "table_name": "work_orders_history", "rows": 29498, "size": "27 MB", "comment": None},
]

# Set of all table names (for quick lookup)
TABLE_NAMES = {t["table_name"] for t in CANONICAL_TABLES}


def detect_references(content: str, table_name: str) -> set[str]:
    """Detect references to a specific table in script content.
    Returns set of operation types: 'r' (read), 'w' (write), 'u' (unknown context).
    Tries multiple patterns:
    - .table('NAME'), .table("NAME"), .from_('NAME')
    - FROM NAME, JOIN NAME, INTO NAME, UPDATE NAME, DELETE FROM NAME
    - schema.NAME or "NAME" patterns
    """
    ops = set()
    # Quote-escaped variants for the table name
    name_pat = re.escape(table_name)
    # Allow optional " around it (Customers is quoted)
    quoted_name = rf'"?{name_pat}"?'

    # Supabase SDK: .table('NAME')
    if re.search(rf'\.table\s*\(\s*[\'"]{name_pat}[\'"]', content):
        ops.add('r')  # could be either; default to read, then check verbs below
    # Supabase SDK: .from_('NAME')
    if re.search(rf'\.from_?\s*\(\s*[\'"]{name_pat}[\'"]', content):
        ops.add('r')
    # SQL: FROM NAME, JOIN NAME
    if re.search(rf'\b(FROM|JOIN)\s+(?:public|billing|maintenance|app_checks|ion|email_extraction|billing_audit)?\.?{quoted_name}\b',
                 content, re.IGNORECASE):
        ops.add('r')
    # SQL: INSERT INTO NAME
    if re.search(rf'\bINSERT\s+INTO\s+(?:public|billing|maintenance|app_checks|ion|email_extraction|billing_audit)?\.?{quoted_name}\b',
                 content, re.IGNORECASE):
        ops.add('w')
    # SQL: UPDATE NAME SET
    if re.search(rf'\bUPDATE\s+(?:public|billing|maintenance|app_checks|ion|email_extraction|billing_audit)?\.?{quoted_name}\b',
                 content, re.IGNORECASE):
        ops.add('w')
    # SQL: DELETE FROM NAME
    if re.search(rf'\bDELETE\s+FROM\s+(?:public|billing|maintenance|app_checks|ion|email_extraction|billing_audit)?\.?{quoted_name}\b',
                 content, re.IGNORECASE):
        ops.add('w')
    # Supabase SDK write methods after .table(): .insert(, .upsert(, .update(, .delete(
    # If we found .table('NAME') AND any write method nearby in the content, mark as write too
    if 'r' in ops:
        # Look for write method calls anywhere in script (heuristic; close enough)
        if re.search(rf'\.table\s*\(\s*[\'"]{name_pat}[\'"][^)]*\)\.(insert|upsert|update|delete)', content):
            ops.add('w')

    return ops


def extract_summary_from_yaml(yaml_path: Path) -> str:
    """Quick extraction of 'summary:' field from a .script.yaml file (avoids YAML dep)."""
    if not yaml_path.exists():
        return ""
    try:
        text = yaml_path.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return ""
    m = re.search(r'^summary:\s*(.+)$', text, re.MULTILINE)
    if m:
        # Strip surrounding quotes if present
        s = m.group(1).strip().strip('"\'')
        return s
    return ""


def find_scripts() -> list[dict]:
    """Walk Windmill scripts AND app code. Returns [{path, content, summary, kind}]
    where kind ∈ {'windmill', 'app'}."""
    scripts = []
    # Windmill scripts
    for base in ['f', 'u']:
        base_path = REPO_ROOT / base
        if not base_path.exists():
            continue
        for p in base_path.rglob('*'):
            if not p.is_file():
                continue
            if p.suffix not in ('.py', '.ts'):
                continue
            try:
                content = p.read_text(encoding='utf-8', errors='ignore')
            except Exception:
                continue
            yaml_path = p.with_suffix('.script.yaml')
            summary = extract_summary_from_yaml(yaml_path)
            scripts.append({
                'path': str(p.relative_to(REPO_ROOT)),
                'content': content,
                'summary': summary,
                'kind': 'windmill',
            })

    # Next.js app code + shared libs + components
    for base in ['app', 'lib', 'components']:
        base_path = REPO_ROOT / base
        if not base_path.exists():
            continue
        for p in base_path.rglob('*'):
            if not p.is_file():
                continue
            if p.suffix not in ('.ts', '.tsx'):
                continue
            # Skip node_modules / next cache
            rel = p.relative_to(REPO_ROOT)
            if 'node_modules' in rel.parts or '.next' in rel.parts:
                continue
            try:
                content = p.read_text(encoding='utf-8', errors='ignore')
            except Exception:
                continue
            scripts.append({
                'path': str(rel),
                'content': content,
                'summary': '',  # app code has no summary metadata
                'kind': 'app',
            })

    # Edge functions (deno) in supabase/functions/
    sf_path = REPO_ROOT / 'supabase' / 'functions'
    if sf_path.exists():
        for p in sf_path.rglob('*.ts'):
            if not p.is_file():
                continue
            try:
                content = p.read_text(encoding='utf-8', errors='ignore')
            except Exception:
                continue
            scripts.append({
                'path': str(p.relative_to(REPO_ROOT)),
                'content': content,
                'summary': '',
                'kind': 'edge',
            })

    return scripts


def main():
    scripts = find_scripts()
    print(f"Loaded {len(scripts)} scripts and {len(CANONICAL_TABLES)} tables")

    # script_path -> {table_name: set('r','w')}
    script_to_tables: dict[str, dict[str, set[str]]] = defaultdict(dict)
    # table_name -> {script_path: set('r','w')}
    table_to_scripts: dict[str, dict[str, set[str]]] = defaultdict(dict)

    # Track kind per path too (so the report can mark windmill vs app)
    script_kinds: dict[str, str] = {s['path']: s['kind'] for s in scripts}
    script_summaries: dict[str, str] = {s['path']: s['summary'] for s in scripts}

    for s in scripts:
        for table in TABLE_NAMES:
            ops = detect_references(s['content'], table)
            if ops:
                script_to_tables[s['path']][table] = ops
                table_to_scripts[table][s['path']] = ops

    # Build summary dicts for serialization
    output = {
        'meta': {
            'script_count': len(scripts),
            'table_count': len(CANONICAL_TABLES),
        },
        'tables': [],
        'scripts': [],
        'orphan_tables': [],
        'orphan_scripts': [],
    }

    # Per-table
    for t in CANONICAL_TABLES:
        qname = f"{t['schema']}.{t['table_name']}"
        refs = table_to_scripts.get(t['table_name'], {})
        script_entries = [
            {'path': sp, 'ops': sorted(ops), 'kind': script_kinds.get(sp, '?')}
            for sp, ops in sorted(refs.items())
        ]
        output['tables'].append({
            'schema': t['schema'],
            'name': t['table_name'],
            'qualified': qname,
            'rows': t['rows'],
            'size': t['size'],
            'comment': t['comment'],
            'scripts': script_entries,
            'script_count': len(refs),
            'windmill_count': sum(1 for e in script_entries if e['kind'] == 'windmill'),
            'app_count': sum(1 for e in script_entries if e['kind'] == 'app'),
            'edge_count': sum(1 for e in script_entries if e['kind'] == 'edge'),
        })
        if not refs:
            output['orphan_tables'].append({
                'schema': t['schema'], 'name': t['table_name'],
                'rows': t['rows'], 'comment': t['comment'],
            })

    # Per-script
    for s in scripts:
        refs = script_to_tables.get(s['path'], {})
        output['scripts'].append({
            'path': s['path'],
            'kind': s['kind'],
            'summary': s['summary'],
            'tables': [
                {'name': t, 'ops': sorted(ops)}
                for t, ops in sorted(refs.items())
            ],
            'table_count': len(refs),
        })
        if not refs:
            output['orphan_scripts'].append({
                'path': s['path'], 'kind': s['kind'], 'summary': s['summary'],
            })

    # Write JSON
    # Output destination: /docs/audits/ — keeps generated artifacts alongside
    # the human-written audit docs, out of the repo root.
    OUT_DIR = REPO_ROOT / 'docs' / 'audits'
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    json_path = OUT_DIR / 'table_script_matrix.json'
    json_path.write_text(json.dumps(output, indent=2, default=list), encoding='utf-8')
    print(f"Wrote JSON: {json_path}")

    # Write Markdown
    md_path = OUT_DIR / '2026-05-27-table-script-matrix.md'
    md = []
    md.append("# Table ↔ Script Cross-Reference Matrix")
    md.append("")
    windmill_count = sum(1 for s in scripts if s['kind'] == 'windmill')
    app_count = sum(1 for s in scripts if s['kind'] == 'app')
    edge_count = sum(1 for s in scripts if s['kind'] == 'edge')
    md.append(f"Generated {len(scripts)} code files × {len(CANONICAL_TABLES)} tables.")
    md.append("")
    md.append(f"**Code files scanned**:")
    md.append(f"- Windmill scripts (`f/`, `u/`): {windmill_count}")
    md.append(f"- App code (`app/`, `lib/`, `components/`): {app_count}")
    md.append(f"- Edge functions (`supabase/functions/`): {edge_count}")
    md.append("")
    md.append(f"**Coverage**:")
    md.append(f"- Code files with no table references: {len(output['orphan_scripts'])}")
    md.append(f"- Tables with no code references: {len(output['orphan_tables'])}")
    md.append("  - Of which empty (0 rows): " + str(sum(1 for t in output['orphan_tables'] if t['rows'] == 0)) + " ← **safest to drop**")
    md.append("  - Of which with data: " + str(sum(1 for t in output['orphan_tables'] if t['rows'] > 0)) + " ← **needs investigation**")
    md.append("")
    md.append("---")
    md.append("")
    md.append("## How to read this report — caveats")
    md.append("")
    md.append("A table can be **actively used** even with zero code references in this report:")
    md.append("")
    md.append("- **Trigger-populated tables**: e.g., `public.inventory_movements` (84k rows) is filled by `sync_inventory_movements()` triggers on `adjustments`/`purchases`/`sales`/`transfers`. Code touches the source tables; the trigger touches this one. Same for `public.work_orders_history` (history trigger) and `public.qbo_sales_by_sku`.")
    md.append("- **Function/RPC-accessed**: e.g., `public.vault_config` is only read by the `get_public_key()` Postgres function called via Supabase RPC.")
    md.append("- **External-repo-accessed**: `app_checks.*` tables are written by `f/check_buddy/*` Windmill scripts (now in the report) AND read by the separate check_buddy UI repo (not scanned here).")
    md.append("- **Generated columns / views**: tables can be referenced indirectly through views (`v_*`).")
    md.append("")
    md.append("So `orphan + has data` ≠ \"safe to drop\". `orphan + 0 rows + no triggers populate it` ≈ safe to drop.")
    md.append("")
    md.append("---")
    md.append("")
    md.append("## 1. Tables with NO code references")
    md.append("")
    md.append("Safest cleanup candidates are at the top (empty + no references).")
    md.append("")
    md.append("| Schema | Table | Rows | Comment |")
    md.append("|---|---|---|---|")
    # Sort by rows ascending (empty first)
    for t in sorted(output['orphan_tables'], key=lambda x: (x['rows'], x['name'])):
        comment = (t['comment'] or '').replace('|', '\\|').replace('\n', ' ')[:80]
        md.append(f"| {t['schema']} | {t['name']} | {t['rows']} | {comment} |")
    md.append("")
    md.append("---")
    md.append("")
    md.append("## 2. Code files with NO table references")
    md.append("")
    md.append("These files don't read or write any Supabase table. They may call external APIs (QBO, OpenAI, etc.), do pure computation, or be utility/type files.")
    md.append("")
    md.append("| File | Kind | Summary |")
    md.append("|---|---|---|")
    for s in sorted(output['orphan_scripts'], key=lambda x: (x['kind'], x['path'])):
        summary = (s['summary'] or '').replace('|', '\\|').replace('\n', ' ')[:100]
        md.append(f"| `{s['path']}` | {s['kind']} | {summary} |")
    md.append("")
    md.append("---")
    md.append("")
    md.append("## 3. Tables grouped by schema (with their code references)")
    md.append("")
    md.append("**Op key**: `r` = read, `w` = write, `r,w` = both. **Kind**: `wm` = Windmill script, `app` = Next.js code, `edge` = Supabase Edge function.")
    md.append("")
    schemas = sorted({t['schema'] for t in output['tables']})
    for schema in schemas:
        md.append(f"### {schema}")
        md.append("")
        md.append("| Table | Rows | Code touching it |")
        md.append("|---|---|---|")
        for t in sorted(output['tables'], key=lambda x: x['name']):
            if t['schema'] != schema:
                continue
            if not t['scripts']:
                continue  # already listed in section 1
            kind_short = {'windmill': 'wm', 'app': 'app', 'edge': 'edge'}
            entries = []
            for s in t['scripts'][:30]:
                k = kind_short.get(s['kind'], s['kind'])
                entries.append(f"`{s['path']}` [{k}] ({','.join(s['ops'])})")
            scripts_str = "<br>".join(entries)
            if len(t['scripts']) > 30:
                scripts_str += f"<br>... and {len(t['scripts']) - 30} more"
            md.append(f"| **{t['name']}** | {t['rows']} | {scripts_str} |")
        md.append("")
    md.append("")
    md.append("---")
    md.append("")
    md.append("## 4. Code grouped by domain (with their tables)")
    md.append("")
    md.append("Domain = first two path segments (e.g., `f/service_billing`, `app/api/billing`). Sorted by domain.")
    md.append("")
    # Group scripts by domain (first two segments)
    scripts_by_domain: dict[str, list[dict]] = defaultdict(list)
    for s in output['scripts']:
        parts = s['path'].split('/')
        if len(parts) >= 3:
            domain = f"{parts[0]}/{parts[1]}/{parts[2]}" if parts[0] == 'app' and parts[1] == 'api' else f"{parts[0]}/{parts[1]}"
        elif len(parts) >= 2:
            domain = f"{parts[0]}/{parts[1]}"
        else:
            domain = parts[0]
        scripts_by_domain[domain].append(s)
    for domain in sorted(scripts_by_domain.keys()):
        md.append(f"### {domain}")
        md.append("")
        md.append("| File | Kind | Summary | Tables touched |")
        md.append("|---|---|---|---|")
        for s in sorted(scripts_by_domain[domain], key=lambda x: x['path']):
            summary = (s['summary'] or '').replace('|', '\\|').replace('\n', ' ')[:80]
            tables_str = ", ".join(
                f"{t['name']} ({','.join(t['ops'])})"
                for t in s['tables'][:15]
            )
            if len(s['tables']) > 15:
                tables_str += f" ... +{len(s['tables']) - 15} more"
            if not tables_str:
                tables_str = "_(none)_"
            short_path = s['path'].rsplit('/', 1)[-1]
            md.append(f"| `{short_path}` | {s['kind']} | {summary} | {tables_str} |")
        md.append("")

    md_path.write_text("\n".join(md), encoding='utf-8')
    print(f"Wrote markdown: {md_path}")
    print(f"\nSummary:")
    print(f"  - Total scripts: {len(scripts)}")
    print(f"  - Scripts with no table refs: {len(output['orphan_scripts'])}")
    print(f"  - Total tables: {len(CANONICAL_TABLES)}")
    print(f"  - Tables with no script refs: {len(output['orphan_tables'])}")
    print(f"  - Tables with no refs AND 0 rows: {sum(1 for t in output['orphan_tables'] if t['rows'] == 0)}")


if __name__ == '__main__':
    main()
