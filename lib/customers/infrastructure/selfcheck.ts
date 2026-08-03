/**
 * Customers ACL self-check: `npx tsx lib/customers/infrastructure/selfcheck.ts`
 * The matching RULE only — no ION, no database.
 */

import assert from "node:assert"
import { matchIonCustomer } from "./ion-customer-directory"


const target = { firstName: "Mark", lastName: "Brooks", street: "106 Kent Trail" }
const row1 = { ionCustId: "111", rowText: "BROOKS, MARK 106 Kent Trail Pooler GA (973) 943-8251" }
const row2 = { ionCustId: "222", rowText: "BROOKS, MARK 9 Other Way Savannah GA" }
const noise = { ionCustId: "333", rowText: "BROOKSTONE, AMY 4 Elm St" }

// one name match links; street agreement makes it high
assert.deepStrictEqual(matchIonCustomer(target, [row1, noise]), { kind: "linked", id: "111", method: "api_fuzzy", confidence: "high" })
// several name matches, exactly one street-confirmed -> that one, high
assert.deepStrictEqual(matchIonCustomer(target, [row2, row1]), { kind: "linked", id: "111", method: "api_fuzzy", confidence: "high" })
// several with no street tie-break -> a human decides, never a guess
assert.strictEqual(matchIonCustomer({ ...target, street: "" }, [row1, row2]).kind, "ambiguous")
// nothing -> still awaiting the sync
assert.strictEqual(matchIonCustomer(target, [noise]).kind, "not_found")

console.log("customers acl selfcheck: 4 checks passed")
