/**
 * The agreements domain's PUBLISHED CONTRACT — everything above imports
 * here, never a file inside. Renaming inside the module cannot break a
 * caller; a new export is a deliberate act of publication.
 */
export { ServiceAgreement } from "./service-agreement/service-agreement"
export { ActiveAgreement } from "./service-agreement/active-agreement"
export { AgreementRuleError } from "./service-agreement/agreement-rule-error"
export type { Basis } from "./service-agreement/basis"
export type { BillingShape } from "./service-agreement/billing-shape"
export type { DesiredWeek } from "./service-agreement/desired-week"
export type { IonIncarnation } from "./service-agreement/ion-incarnation"
export { samePattern } from "./service-agreement/required-pattern"
export type { RequiredPattern } from "./service-agreement/required-pattern"
export type { Revision } from "./service-agreement/revision"
export type { TermsVersion } from "./service-agreement/terms-version"
