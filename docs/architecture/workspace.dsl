/*
 * JPS Internal — C4 architecture model (Structurizr DSL)
 *
 * Status: [active] — created 2026-06-10 from the architecture audit
 *         (docs/audits/2026-06-10-architecture-and-tech-debt.md).
 *
 * This one file generates every diagram level:
 *   C1 systemContext  — JPS platform among its users + external systems
 *   C2 container      — Next.js app / Windmill / Supabase Postgres
 *   C3 component      — one view per container (modules inside each)
 *   dynamic           — the three load-bearing data flows (SYSTEM_MAP section 4)
 *
 * Render: see README.md in this folder (Structurizr Lite via Docker, or CLI
 * export to Mermaid/PlantUML). Drift rule: if you change reality, change this
 * file in the same PR — same rule as SYSTEM_MAP.md.
 */
workspace "JPS Internal" "Jeff's Pool & Spa Service internal operations platform: service billing, maintenance ops, leads, comms, inventory." {

    !identifiers hierarchical

    model {

        // ---- People -------------------------------------------------------
        staff = person "Office Staff" "Triage invoices, run billing, manage leads, customers and work orders."
        tech = person "Field Technician" "Truck checks and inventory sign-outs from the field. Sandboxed auth."
        customer = person "Customer / Lead" "Submits the website lead form, accepts quotes, enters card details via tokenized links."

        // ---- The system under design --------------------------------------
        jps = softwareSystem "JPS Internal Platform" "Orchestration layer + operational data store over external SaaS leaders (ADR 001). This repo + the Windmill workspace + the shared Supabase project." {

            webapp = container "Next.js App" "Staff and tech UI, API routes, server actions. Deployed on Vercel." "Next.js 16 / React 19 / TypeScript" {
                shellUi = component "Staff UI" "app/(shell): service-billing queue + triage, customers, work orders, leads, maintenance, admin." "React server components"
                techUi = component "Tech UI" "app/(tech): tech-login, truck-check, sign-out. Middleware sandboxes tech accounts by email domain." "React"
                apiRoutes = component "API Routes" "app/api/*: ~40 handlers — billing operations, QBO + Resend webhooks, public lead intake, places proxy." "Next.js route handlers"
                serverActions = component "Server Actions" "9 actions.ts files: form mutations (leads, users, payment methods). All open with requireModuleWrite." "Next.js server actions"
                authz = component "Access Control" "lib/auth: module manifest (service / maintenance / leads / admin), role guards, cached getUserAccess." "TypeScript"
                queryLayer = component "Query + Entity Layer" "lib/queries + lib/entities (8 entity bundles). [attention] used inconsistently — ~69 inline .from() calls bypass it." "TypeScript"
                intake = component "Lead Intake Orchestrator" "lib/leads/intake.ts: dedup, account create/reuse, QBO create at intake (Pattern D), service bodies, quote. One recipe for website + internal form." "TypeScript"
                qboWrite = component "QBO Write-Through" "lib/qbo/write.ts: webhook-expectation write-ahead log, pending cache, sync Windmill call, reflect on webhook." "TypeScript"
                commsClients = component "Comms Clients" "lib/comms/server: Resend (email) + RingCentral (SMS) wrappers + communications audit log." "TypeScript"
                windmillClient = component "Windmill Client" "lib/windmill.ts: triggerScript / triggerScriptSync / triggerFlow / getJobStatus." "TypeScript"
            }

            windmill = container "Windmill Workspace" "Scheduled jobs, flows, and webhook targets. Workspace jps-internal, ~90 scripts (93% Python), mirrored into f/ and u/ in this repo." "Windmill (Python + Bun TypeScript)" {
                svcBilling = component "service_billing" "QBO invoice pipeline: dispatch_pre_processing (60s outbox), pre_process_invoice, process_work_order, cdc_reconciler (15m), reconcile_payments (5m), refresh_* webhook targets." "Python, 23 scripts"
                ionSync = component "ION sync" "f/ION: visits (2h), work_orders (4h), consumables (daily); _lib shared session / parser / normalize / upsert; Chromium scraping." "Python + Bun TS, 40 scripts + 9 flows"
                autopayFlow = component "billing (monthly autopay)" "monthly_autopay flow (manual kickoff): apply credits, roster, per-customer charge + receipt; send_monthly_invoices; decline emails." "Windmill flow + Python"
                auditScripts = component "billing_audit" "load_month + compute_chemical_estimates (monthly): pre-billing chemical-overcharge audit." "Python"
                commsScripts = component "comms + alerts" "send_email, send_sms, quote_followup_cadence (daily 9am), send_pending_system_alerts (5m)." "Python"
                qboSync = component "qbo" "qbo_customer_sync (daily 5am), sync_customer_to_qbo, qbo_customer_write (Pattern D customer create)." "Python"
                integrations = component "email_extraction / google_maps / webhooks" "Allied Universal invoice-PDF extraction (Gmail), customer geocoding, Gusto employee sync." "Python"
                scratch = component "u/carter scratch" "[attention] 30 ad-hoc scripts including production Zoho inventory pulls, RingCentral utilities, 3 ion_task_recon variants." "Python + TS"
            }

            db = container "Supabase Postgres" "Operational data store: caches of external leaders + app-owned workflow state. Project vvprodiuwraceabviyes — THE shared resource across repos." "PostgreSQL + pg_net" {
                tags "Database"
                publicSchema = component "public schema" "Shared kernel: Customers (QBO-mirrored identity), work_orders (ION-mirrored), leads envelope, employees, comms, inventory, card vault." "Schema"
                billingSchema = component "billing schema" "invoices (indicator/projection state machine), customer_payments, payment methods, autopay_*, webhook_log + expectations, drift_log, cdc_cursors." "Schema"
                billingAuditSchema = component "billing_audit schema" "maintenance_invoices, task_billing_periods, line items. ADR 003: fold into billing.invoices (link_kind-routed)." "Schema"
                maintSchema = component "maintenance schema" "tasks, task_schedules, visits, visit_tasks, chem_readings, consumables_usage, onboarding, residential_lead_details." "Schema"
                rpcLayer = component "RPC layer" "~51 SQL functions; SECURITY DEFINER with role checks; canonical lead-lifecycle RPCs (ADR 004)." "PL/pgSQL"
                dbTriggers = component "Triggers + pg_net fan-out" "Indicator/projection triggers on billing.invoices; lead lifecycle sync; pg_net HTTP posts to Windmill webhooks (vault windmill_token)." "PL/pgSQL + pg_net"
            }
        }

        // ---- Sibling systems (other repos, same Supabase) ------------------
        leadSite = softwareSystem "Public Website (lead form)" "Separate repo (perfectpools). Public intake form; posts to /api/leads with x-api-key." "Sibling"
        checkBuddy = softwareSystem "check_buddy" "Separate repo + UI. QBO check/deposit reconciliation. Owns app_checks schema; its scripts live at f/check_buddy in the shared Windmill workspace." "Sibling"

        // ---- External SaaS (leaders) ---------------------------------------
        qbo = softwareSystem "QuickBooks Online + Intuit Payments" "Financial leader: customers, invoices, payments; card/ACH charging. OAuth refresh token rotates." "External"
        ion = softwareSystem "ION Pool Care" "Field-service leader: work orders, visits, tasks. ColdFusion app — no API, scraped via Chromium." "External"
        rc = softwareSystem "RingCentral" "Calls + SMS." "External"
        gmail = softwareSystem "Gmail" "Outbound billing email; inbox source for PDF extraction." "External"
        resend = softwareSystem "Resend" "Transactional email + bounce/complaint webhooks." "External"
        openai = softwareSystem "OpenAI" "Invoice memo generation." "External"
        zoho = softwareSystem "Zoho Inventory" "Item catalog + inventory transactions." "External"
        gmaps = softwareSystem "Google Maps / Mapbox" "Geocoding, address autocomplete, static maps." "External"
        gusto = softwareSystem "Gusto" "Payroll system; daily employee sync." "External"

        // ---- Container-level relationships ---------------------------------
        staff -> jps.webapp "Uses: billing queue, triage, leads, maintenance, admin" "HTTPS"
        tech -> jps.webapp "Truck checks + inventory sign-outs" "HTTPS"
        customer -> leadSite "Submits lead form"
        customer -> jps.webapp "Opens accept-quote + card-collection links" "HTTPS"

        leadSite -> jps.webapp "POST /api/leads (x-api-key)" "HTTPS / JSON"
        checkBuddy -> jps.db "Owns app_checks schema; reads public" "Postgres"

        jps.webapp -> jps.db "Reads/writes + RPCs (anon, session, service-role clients)" "Supabase JS"
        jps.webapp -> jps.windmill "Triggers scripts + flows (sync + async), polls job status" "HTTPS (lib/windmill.ts)"
        jps.webapp -> resend "Sends transactional email" "HTTPS"
        jps.webapp -> rc "Sends SMS" "HTTPS"
        jps.webapp -> gmaps "Address autocomplete + static maps (server-side proxy)" "HTTPS"
        qbo -> jps.webapp "Entity-change webhooks to /api/webhooks/qbo (HMAC-verified)" "HTTPS"
        resend -> jps.webapp "Bounce/complaint webhooks" "HTTPS"

        jps.windmill -> jps.db "Direct SQL reads/writes (psycopg2 in ~48 scripts)" "Postgres"
        jps.db -> jps.windmill "pg_net triggers fire webhooks (at-most-once; 60s outbox backstop)" "HTTPS"
        jps.windmill -> qbo "Invoices, payments, charges, customers; CDC polling" "OAuth REST"
        jps.windmill -> ion "Logs in, scrapes reports + work orders" "Playwright / Chromium"
        jps.windmill -> rc "SMS sends, call data, transcripts" "REST"
        jps.windmill -> gmail "Outbound billing email; PDF inbox extraction" "Gmail API"
        jps.windmill -> openai "Invoice memo generation" "REST"
        jps.windmill -> zoho "Daily inventory pulls" "REST"
        jps.windmill -> gmaps "Customer geocoding" "REST"
        jps.windmill -> gusto "Daily employee sync" "REST"

        // ---- Component-level relationships (declared after container-level
        //      so implied relationships do not duplicate the edges above) ----

        // Inside the Next.js app
        jps.webapp.shellUi -> jps.webapp.serverActions "Form submits"
        jps.webapp.shellUi -> jps.webapp.queryLayer "Server-component data fetch"
        jps.webapp.shellUi -> jps.webapp.apiRoutes "Mutations, refreshes, job polling"
        jps.webapp.shellUi -> jps.webapp.authz "requireModuleAccess per page"
        jps.webapp.techUi -> jps.webapp.serverActions "Form submits"
        jps.webapp.serverActions -> jps.webapp.authz "requireModuleWrite"
        jps.webapp.apiRoutes -> jps.webapp.authz "guardApi"
        jps.webapp.apiRoutes -> jps.webapp.windmillClient "Billing ops, QBO refreshes, webhook dispatch"
        jps.webapp.apiRoutes -> jps.webapp.intake "POST /api/leads (website entry point)"
        jps.webapp.serverActions -> jps.webapp.intake "Internal lead form entry point"
        jps.webapp.intake -> jps.webapp.qboWrite "Create QBO customer at intake (Pattern D)"
        jps.webapp.qboWrite -> jps.webapp.windmillClient "Sync call to qbo_customer_write"
        jps.webapp.serverActions -> jps.webapp.commsClients "Quote emails, card-link SMS"
        jps.webapp.queryLayer -> jps.db "Selects + read RPCs"
        jps.webapp.serverActions -> jps.db "Lifecycle RPCs + direct writes"
        jps.webapp.apiRoutes -> jps.db "Direct reads/writes, webhook logging"
        jps.webapp.windmillClient -> jps.windmill "Run script / flow, poll job" "HTTPS"
        jps.webapp.commsClients -> resend "Email"
        jps.webapp.commsClients -> rc "SMS"

        // Inside Windmill
        jps.windmill.svcBilling -> qbo "Invoice fetch, charge, payment record, CDC"
        jps.windmill.svcBilling -> openai "Memo generation"
        jps.windmill.svcBilling -> jps.db "billing.* + public.work_orders"
        jps.windmill.ionSync -> ion "Session + report scrape"
        jps.windmill.ionSync -> jps.db "maintenance.* upserts (visits, readings, consumables, tasks)"
        jps.windmill.autopayFlow -> qbo "Monthly charges + receipt email"
        jps.windmill.autopayFlow -> jps.db "billing.autopay_* + billing_runs"
        jps.windmill.auditScripts -> jps.db "billing_audit.*"
        jps.windmill.commsScripts -> gmail "Quote follow-ups, system alerts"
        jps.windmill.commsScripts -> rc "SMS sends"
        jps.windmill.commsScripts -> jps.db "communications log + cadence state"
        jps.windmill.qboSync -> qbo "Customer create / sync"
        jps.windmill.qboSync -> jps.db "public.Customers"
        jps.windmill.integrations -> gmail "Invoice-PDF extraction"
        jps.windmill.integrations -> gmaps "Geocoding"
        jps.windmill.integrations -> gusto "Employee sync"
        jps.windmill.integrations -> jps.db "email_extraction.*, public.employees"
        jps.windmill.scratch -> zoho "Inventory pulls"
        jps.windmill.scratch -> rc "Call lookups, transcription"
        jps.windmill.scratch -> jps.db "Inventory + misc tables"

        // Inside the database
        jps.db.dbTriggers -> jps.windmill "pg_net webhooks: pull_customer_payment_methods, pre_process_invoice, refresh_*" "HTTPS"
    }

    views {

        systemContext jps "C1-Context" "Who and what the platform talks to." {
            include *
            autoLayout lr
        }

        container jps "C2-Containers" "The three running pieces and every edge between them and the outside world." {
            include *
            autoLayout lr
        }

        component jps.webapp "C3-NextJsApp" "Modules inside the Next.js app and where each one reaches." {
            include *
            autoLayout lr
        }

        component jps.windmill "C3-Windmill" "Script areas inside the Windmill workspace and which external systems each touches." {
            include *
            autoLayout lr
        }

        component jps.db "C3-Database" "Schemas, the RPC layer, and the trigger fan-out." {
            include *
            autoLayout lr
        }

        dynamic jps "Flow-WorkOrderToPayment" "Work order to cashed payment — the central flow (SYSTEM_MAP 4.1)." {
            jps.windmill -> ion "Scrapes work orders + visits on schedule"
            jps.windmill -> jps.db "Upserts work_orders; pull_qbo_invoices inserts billing.invoices"
            jps.db -> jps.windmill "AFTER INSERT trigger (pg_net): PM refresh + pre_process_invoice"
            jps.windmill -> qbo "Fetches invoice, payment methods, open credits"
            jps.windmill -> openai "Generates invoice memo"
            jps.windmill -> jps.db "Writes enrichment; indicator triggers project billing_status = ready_to_process"
            staff -> jps.webapp "Reviews queue / triage, clicks Charge"
            jps.webapp -> jps.windmill "Triggers process_work_order"
            jps.windmill -> qbo "Applies credits, charges card/ACH, records Payment, sends invoice email"
            jps.windmill -> jps.db "processing_attempts + payment rows; auto-promote to processed"
            autoLayout lr
        }

        dynamic jps "Flow-LeadIntake" "Lead intake to conversion (SYSTEM_MAP 4.2, ADR 004, Pattern D)." {
            customer -> leadSite "Submits lead form"
            leadSite -> jps.webapp "POST /api/leads (same orchestrator as the internal /leads/new form)"
            jps.webapp -> jps.db "RPCs: search_accounts_by_contact, create_account, create_service_body, create_maintenance_lead"
            jps.webapp -> jps.windmill "createInQbo: qbo_customer_write (QBO is leader for new customers)"
            jps.windmill -> qbo "Creates customer"
            jps.windmill -> jps.db "Stamps qbo_customer_id; webhook_expectations write-ahead"
            jps.windmill -> gmail "quote_followup_cadence emails quote + accept link (daily)"
            customer -> jps.webapp "Accepts quote (resume token), enters card via collection link"
            jps.webapp -> jps.db "mark_payment_on_file: onboarding row; child status converted; lifecycle closed"
            autoLayout lr
        }

        dynamic jps "Flow-IonVisitSync" "ION visit sync every 2 hours (SYSTEM_MAP 4.4)." {
            jps.windmill -> ion "emit_session logs in (Chromium); downloads service-log XLS"
            jps.windmill -> jps.db "normalize + upsert: visits, chem_readings, consumables_usage, visit_tasks; links tasks + schedules"
            autoLayout lr
        }

        styles {
            element "Person" {
                shape person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
            element "Database" {
                shape cylinder
            }
            element "External" {
                background #8c8c8c
                color #ffffff
            }
            element "Sibling" {
                background #b86950
                color #ffffff
            }
        }
    }
}
