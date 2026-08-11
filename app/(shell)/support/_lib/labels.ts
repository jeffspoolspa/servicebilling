/**
 * Display names for the domain's vocabulary. The WIRE values stay exactly
 * as the enum spells them ("PhoneCall") — that is the contract with .NET,
 * and inserting a space in it would be a breaking change. Only the reading
 * is prettied up, in one place, so the table and the form always agree.
 */
export const CHANNEL_LABEL: Record<string, string> = {
  PhoneCall: "Phone Call",
  Email: "Email",
  Text: "Text",
  WalkIn: "Walk-In",
  Internal: "Internal",
}

export const channelLabel = (value: string) => CHANNEL_LABEL[value] ?? value
