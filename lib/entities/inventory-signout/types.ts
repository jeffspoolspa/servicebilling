export type SignOutCategory = "chemical" | "part"

export interface SignOutItem {
  id: number
  sku: string | null
  item_name: string | null
  /** Cleaned-up label shown in the dropdown. */
  display_name: string
  /** Dropdown group. */
  category: SignOutCategory
  /** 1 for simple items; >1 for bulk items where tech enters containers. */
  multiplier: number
  /** Singular input unit (e.g. "bucket", "bag"). Null for simple items. */
  input_unit: string | null
  /** Base stock unit (e.g. "lb", "tab"). Null for simple items. */
  stock_unit: string | null
}

export interface SignOutRowInput {
  item_id: number
  quantity: number
}

export interface SignOutRecord {
  id: number
  employee_id: string
  item_id: number
  quantity: number
  signed_out_at: string
  created_at: string
}
