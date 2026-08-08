/**
 * Where task forms come from. The adapter is the Windmill batch fetcher
 * (f/ION/api/get_task_forms_batch — one warm session, custId-primed); the
 * sentence never knows that. A fetch failure is DATA (ok:false), not an
 * exception — failure is a stored state.
 */
export interface TaskFormSource {
  fetchForms(
    tasks: readonly { ionTaskId: string; ionCustId: string }[],
  ): Promise<
    (
      | { ionTaskId: string; ok: true; fields: Record<string, string>; detail: unknown }
      | { ionTaskId: string; ok: false; error: string }
    )[]
  >
}
