# Lead Intake → Conversion — Flow Map (Layer 3)

> Status: [active]
> Flow: [index](index.md)

```mermaid
sequenceDiagram
  participant U as Website / Internal form
  participant API as submitLeadIntake (/api/leads)
  participant DB as Supabase (RPCs)
  participant W as Windmill
  participant QBO as QuickBooks
  participant WH as App QBO webhook
  U->>API: account + bodies + lead (source)
  API->>DB: search_accounts_by_contact (dedup)
  alt match
    API->>DB: update_account_contact (reuse account)
  else new
    API->>DB: create_account -> Customers + service_location
    API->>W: createInQbo -> qbo_customer_write (POST)
    W->>QBO: create Customer
    QBO-->>W: 200 + canonical Customer
    W-->>API: qbo_id, entity
    API->>DB: stamp qbo_customer_id + awaiting_propagation; webhook_expectations(Customer)
    QBO-->>WH: Customer webhook (async)
    WH->>DB: refresh_customer (sync_state=synced) + confirm_webhook_expectation
  end
  API->>DB: create_service_body (per body)
  API->>DB: create_maintenance_lead (computed quote) -> leads + residential_lead_details(status=new)
  API-->>U: { account_id, lead_id, quoted_per_visit, qbo }
  U->>DB: mark_lead_quoted   %% quoted
  U->>DB: accept_lead        %% accepted
  U->>DB: create_card_collection_request -> mark_payment_on_file   %% converted + onboarding
  DB->>DB: sync_lead_lifecycle_from_child -> lifecycle_state=closed
```

**Steps (click for detail):**
1. **Intake** — `submitLeadIntake` (`/api/leads` for the website; server action for the internal form): dedup → `create_account`/`update_account_contact` → `create_service_body` → `create_maintenance_lead`. Creates the [Customer](../../entities/customer.md) + [Lead](../../entities/lead.md). `[write-out -> Supabase]`
2. **Create in QBO (new customer)** — `createInQbo('customer')` → `f/service_billing/qbo_customer_write`. `[write-out -> QBO]`
3. **Reflect** — QBO Customer webhook → `f/service_billing/refresh_customer` (`sync_state=synced`) + `confirm_webhook_expectation`. `[reflection <- QBO]`
4. **Quote** — `mark_lead_quoted`. `[internal]`
5. **Accept** — `accept_lead` (resume-token gated). `[internal]`
6. **Card on file** — `create_card_collection_request` → `mark_payment_on_file`. `[internal]`
7. **Close projection** — `sync_lead_lifecycle_from_child` trigger. `[internal]`

**Failure modes:**
| Failure | Where | Detected by | Recovery |
|---|---|---|---|
| Out of service area (no explicit office) | intake | `checkServiceArea` | reject; internal form may pass `allow_out_of_area` |
| QBO customer create fails | intake (new customer) | `sync_state='sync_failed'` | lead unaffected; retry or CDC / daily sync reconciles |
| QBO Customer webhook never arrives | post-create | expectation open past `expected_by` | CDC (Customer, 15 min) + daily `qbo_customer_sync` |
| account / body / lead RPC fails | intake | RPC error | returned to caller; the form re-shows it |
| Expired/mismatched resume token | accept | token check | RAISE; re-quote to re-issue a token |

**Concurrency:** `f/service_billing/qbo_customer_write` touches QBO — key `qbo_api` (rotating refresh
token; read the `quickbooks-windmill` skill). See [CONCURRENCY_KEYS.md](../../conventions/CONCURRENCY_KEYS.md).
