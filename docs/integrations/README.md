# Integrations

> Status: [active]

One page per external system this repo talks to. Each documents the auth pattern, the resource/secret it uses, the concurrency key that throttles it, and which flows depend on it. Per [ADR 001](../adrs/001-platform-architecture.md), external systems are **leaders** — they own their data; we cache it and write back through documented contracts.

| Integration | Role | Concurrency key |
|---|---|---|
| [QBO](qbo.md) | Invoice financial state + payment records (leader) | `qbo_api`, `qbo_writer` |
| Intuit Payments | Charges cards/ACH | `intuit_payments` |
| [ION Pool Care](ion.md) | Work orders + visits (leader) — to be written | `ion_chromium` |
| [Gmail](gmail.md) | Receipt + invoice email (outbound) | `gmail_api` |
| [OpenAI](openai.md) | Memo generation in pre_process | `openai_api` |

See [CONCURRENCY_KEYS.md](../conventions/CONCURRENCY_KEYS.md) for the shared-budget registry.

> Integrations not yet written get a `[stub]` page. ION, Intuit Payments, and others (RingCentral, Zoho, Resend, Pipedream) are added as their modules are documented.
