# ADR 012: One object per external system, one translator, thin services

> Status: [accepted] — decided with Carter 2026-08-03 after the routing publish
> shipped. Every failure that week had one root: knowledge living in transport
> (Windmill scripts, ad-hoc wrappers) instead of in an object that owns it.

## Decision

**1. One Ion class, one file** — `lib/infrastructure/ion/ion.ts`. ALL ION
communication, zero domain logic. Abstract base owns sessions (validity-checked
keys, re-mint via the single chromium Windmill script only when dead), keyed
fetch/post, the CF AJAX envelope, customer priming. One method per action
(readTask, writeTask, setStartDate, createTask, …), each carrying its
hard-won rules internally: fields==0 is a FAILED READ; writes are proven by
READ-BACK, never status codes; backdated StartsOn needs the _proxy pre-set
with the full envelope. Same pattern for every external system (QBO, Gusto…).

**2. One ACL** — `lib/infrastructure/ion/acl.ts`. Sole purpose: translate ION's
shape to ours and back. DAY_FIELD, ServiceRepeat maps, "biweekly renders no
day picker", tech-id maps — here and nowhere else. Application services pass
data THROUGH it; domain objects never see an ION word.

**3. Application services read as one sentence.** publishScenario:
take id → DB repo says which tasks are stale → refresh those → restore the
scenario (fresh changes or honest invalidations) → changes through the ACL →
Ion object applies and returns READ-BACK-VERIFIED results → confirmed ones to
the cache and the event stream → batch closes the scenario. Collaborators are
constructor-injected named ports; freshness is a REQUIRED precondition, not an
option; no cadence/field/envelope knowledge above the ACL line.

## Why (the receipts)

- Bare proxy call failed; only the browser-traced CF envelope worked — that
  knowledge was re-derived three times because no object owned it.
- resolve() grew to 150 lines because no ACL owned translation.
- The publisher trusted cached `frequency` and rebased 27 StartsOn dates; the
  ACL + Ion methods make the wrong path unrepresentable.
