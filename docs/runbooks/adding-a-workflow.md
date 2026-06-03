# Runbook: Adding (or changing) a workflow

> Status: [active]
> Last updated: 2026-06-03

A **workflow** (a.k.a. flow) is an end-to-end business process that crosses multiple
entities and scripts — e.g. monthly autopay, work-order-to-payment, monthly maintenance
billing. This runbook is how you design, build, and document one so it lands coherently.
The doc is not an afterthought: for new work it is the **spec you design against**.

See the template: [`../conventions/FLOW_TEMPLATE.md`](../conventions/FLOW_TEMPLATE.md).

## When to use this

- Building a new flow.
- Substantially changing an existing flow (new branch, new external call, changed grain).
- Reverse-documenting a flow that exists in code but isn't written down yet.

## The procedure — four layers, in this order

The order is deliberate: each layer constrains the next. Doing them out of order means
redrawing work.

### Layer 0 — Locate it on the system map (minutes)
Open [`../SYSTEM_MAP.md`](../SYSTEM_MAP.md). Confirm which containers the flow touches
(Windmill, Supabase, QBO, ION, ...). If the flow adds a *new* node or edge to the
architecture, update the system-map container diagram too. Usually you are just
confirming where the new thing plugs in — do not redraw the whole map.

### Layer 1 — Schema Contract (the foundation; do it carefully)
List exactly what the flow **reads**, **writes**, and **calls** (external APIs), with
precise table and field names (`public."Customers"`, capital C, quoted). List the
**critical invariants** — things that must be true about the data for the flow to work
(e.g. "`billing.invoices.qbo_invoice_id` must be populated before the charge step").
This is the layer that tells you *what breaks* when a schema changes.

### Layer 2 — Decision Map (the highest-value layer)
Every branch, gate, and business rule written as **explicit logic, before it becomes
code**: pre-conditions, the ordered if/else decision sequence, failure handling (retry
vs halt, where it logs), and post-conditions. This is the layer a diagram cannot capture
and the one you will be grateful for when something breaks at 9pm.

### Layer 3 — Flow Map (drawn last)
The flow is a *synthesis* of Layers 1 + 2 — you cannot sequence operations correctly
until you know what data exists at each step and what governs the branches. Draw a
Mermaid sequence diagram (or flowchart), show the **error path explicitly** (an `alt`
block, not omitted), and pair it with numbered click-through steps. Follow the house
Mermaid conventions in [`../conventions/FLOW_TEMPLATE.md`](../conventions/FLOW_TEMPLATE.md).

## Design-first: mark `[design]`, build against it, flip to `[verified]`
For new work the diagram is the spec — set `> Verification: [design]`, align on it,
implement against it, then flip to `[verified]` once the code matches. For existing code,
reverse-engineer to `[verified]`, or `[drift]` if intent and reality disagree.

## Why this order
Draw the flow first and you will redraw it once you hit the real field names and edge
cases. A rough sketch up front is fine for orientation; the *formal* flow map is finished
last.

## Output
A new `docs/flows/<workflow-name>.md` filled out from the template, linked from the entity
docs it touches, plus a `docs/SYSTEM_MAP.md` update if it changed the architecture. Then
follow [`changing-the-system.md`](changing-the-system.md) to ship code + docs together.
