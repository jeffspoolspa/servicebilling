export interface Employee {
  id: string
  gusto_uuid: string | null
  employee_code: string | null
  first_name: string | null
  last_name: string | null
  display_name: string
  email: string | null
  phone: string | null
  status: "active" | "terminated" | "onboarding"
  hire_date: string | null
  department_id: string | null
  branch_id: string | null

  // Service-billing-specific
  ion_username: string[] | null

  // Auth (org-wide)
  auth_user_id: string | null

  created_at: string
  updated_at: string
}
