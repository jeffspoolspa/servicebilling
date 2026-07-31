-- ION employee id: the value ION's per-weekday tech <select> carries on the task
-- edit form (day1..day7). Routing's write-back needs it to name a tech in ION;
-- employees.ion_username already stores ION's exact roster display string, so the
-- id is an equality join away and is persisted here rather than resolved by name
-- at write time (ADR 006 pattern: fuzzy-match once, then store the identity).
--
-- One id per employee. A person with two ION identities (an office move) keeps
-- the current one; ION's own roster is the check -- writing an id the task's
-- dropdown does not offer would be refused there.
alter table public.employees add column if not exists ion_employee_id text;

comment on column public.employees.ion_employee_id is
  'ION employee id (option value in the task form day1..day7 tech selects). Backfilled by exact match of employees.ion_username against the ION roster. The routing publisher writes this value; null means this employee cannot be published to ION.';

create index if not exists employees_ion_employee_id_idx
  on public.employees (ion_employee_id) where ion_employee_id is not null;

-- Backfill from the roster ION itself serves on the task form (74 options, of
-- which these are the staff ones). Verified: all 28 techs holding an active
-- routing slot resolve to exactly one id, and no id is claimed twice.
with roster(ion_id, ion_name) as (values
 ('15087','OFC-C DS, DONIVAN'),('30212','MNT-B JH, JAYDEN'),('30367','MNT-C JF, JFRANCIS'),
 ('31333','MNT-C TR, REDMON'),('31409','MNT-RH TW, TIM'),('31410','MNT-RH JW, JOSH'),
 ('31412','MNT-RH CC, CHANDLER'),('31413','MNT-RH TC, TONY'),('31414','MNT-RH JC, COOPER'),
 ('31416','MNT-RH GC, GRAHAM'),('31419','MNT-RH WM, WILLIAM'),('31508','MNT-B AN, AARON N'),
 ('31614','MNT-RH BW, BILL'),('31793','MNT-RH MATT, BUHLMANN'),('31885','MNT-C JM, JACK'),
 ('31937','MNT-RH LC, LEE'),('32002','MNT-RH JH, JHILLER'),('32032','MNT-RH RB, ROBB'),
 ('32046','MNT-B GC, GABE'),('32109','MNT-RH TH, TIMHILL'),('32419','MNT-RH EA, ELAINA'),
 ('32467','MNT-B ET, EMMAN'),('32468','MNT-B AO, ANDR'),('32763','MNT-B WM, WILLIAM'),
 ('32819','MNT-C KF, KOREY'),('33083','MNT-B CV, CARLOS'),('33189','MNT-B JT, JAMIE'),
 ('33290','MNT-RH EL, ZEKE'),('33297','MNT-RH CT, CANDICE'),('33323','MNT-B JC, JOSH C'),
 ('33425','MNT-B EL, ERNIE'),('33479','MNT-RH CB, CALEB'),('33481','MNT-RH AR, ANTHONY'),
 ('33516','MNT-B WG, WESLEY'),('33541','MNT-B DE, DELMORE'),('33623','MNT-B JP, JPOWELL'),
 ('28132','MNT-B TR, TAVIN'),('15090','OFC-B ZT, ZACH'),('29643','OFC-C AM, ALISHA'),
 ('30777','OFC-B VW, TORI'),('31358','OFC-RH EC, ERIN'),('31892','OFC-B NG, NELSIE'),
 ('31940','OFC-RH JA, JACKIE'),('31975','OFC-B MK, MARY'),('32211','OFC-B AO, ANNA')
)
update public.employees e
   set ion_employee_id = r.ion_id
  from roster r
 where r.ion_name = any(e.ion_username)
   and e.ion_employee_id is distinct from r.ion_id;
