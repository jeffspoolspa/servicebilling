-- Populate maintenance.tasks.ion_task_id (the canonical 1:1 ION task id) from task_schedules.
-- Background: the ION task id (ion.recurring_tasks.ion_task_id) is 1:1 with a task, but it had
-- only ever been stored on the task_schedules rows (all 2,569 carry it; every task's schedules
-- share one id) and on visits -- NOT on the task row itself (only 65/1,161 were set). That made
-- tasks.ion_task_id a trap: it read as "the join key to ION" but was empty, while the real link
-- rode on task_schedules. Canonical model: the id lives on the task; task_schedules and visits
-- link to the task by task_id; ion_task_id identifies the task. See task-record-linkage.md.
update maintenance.tasks t
set ion_task_id = ts.ion_task_id
from (select task_id, min(ion_task_id) as ion_task_id
      from maintenance.task_schedules
      group by task_id) ts
where ts.task_id = t.id and t.ion_task_id is distinct from ts.ion_task_id;

-- One task per ION task id (enforce the 1:1 going forward).
create unique index if not exists uq_tasks_ion_task_id
  on maintenance.tasks (ion_task_id) where ion_task_id is not null;