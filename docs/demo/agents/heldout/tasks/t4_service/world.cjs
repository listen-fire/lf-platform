// T4's part of the second world: the Facilities base, its Equipment (each
// piece's Next Service date) and its Service Jobs. Dates are days from the
// first morning the grader's schedule fires (`firstMorning`): the next 07:00
// UTC after now, as `listen-fire drain` sees it with the clock moved on.
const BASES = {
  appFACILITIES: {
    name: 'Facilities',
    tables: {
      tblEQUIPMENT: {
        name: 'Equipment',
        primaryFieldId: 'fldEqName',
        fields: [
          { id: 'fldEqName', name: 'Name', type: 'singleLineText' },
          { id: 'fldLocation', name: 'Location', type: 'singleLineText' },
          {
            id: 'fldEqStatus',
            name: 'Status',
            type: 'singleSelect',
            options: { choices: ['Active', 'Retired'].map((name, i) => ({ id: `selQ${i}`, name })) },
          },
          { id: 'fldNext', name: 'Next Service', type: 'date' },
        ],
      },
      tblJOBS: {
        name: 'Service Jobs',
        primaryFieldId: 'fldJobEq',
        fields: [
          { id: 'fldJobEq', name: 'Equipment', type: 'singleLineText' },
          { id: 'fldDue', name: 'Due', type: 'date' },
          {
            id: 'fldJobStatus',
            name: 'Status',
            type: 'singleSelect',
            options: { choices: ['To do', 'Scheduled', 'Done'].map((name, i) => ({ id: `selJ${i}`, name })) },
          },
        ],
      },
    },
  },
};

const DAY = 86_400_000;

/** The first 07:00:30 UTC after `now` (the schedule's first tick, 30 s on). */
function firstMorning(now = Date.now()) {
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 30);
  if (at <= now + 60_000) at += DAY;
  return at;
}

/** The calendar day `days` after the first morning, as Airtable holds a date. */
const day = (days, now) => new Date(firstMorning(now) + days * DAY).toISOString().slice(0, 10);

function equipment(now) {
  const eq = (id, name, location, status, next) => ({ id, fields: { Name: name, Location: location, Status: status, ...(next === null ? {} : { 'Next Service': day(next, now) }) } });
  return [
    eq('recQ1', 'Boiler', 'Basement', 'Active', -3), // overdue: a job
    eq('recQ2', 'Lift', 'Lobby', 'Active', 4), // due in 4 days: a job
    eq('recQ3', 'Fire alarm panel', 'Lobby', 'Active', 40), // not due (brought forward before the second morning)
    eq('recQ4', 'Forklift', 'Warehouse', 'Active', 2), // due, but a job is already scheduled
    eq('recQ5', 'Old compressor', 'Warehouse', 'Retired', -10), // retired: never
    eq('recQ6', 'Projector', 'Meeting room', 'Active', null), // no date: never
    eq('recQ7', 'Generator', 'Yard', 'Active', 1), // due; its last job is done: a job
  ];
}

function jobs(now) {
  return [
    { id: 'recJ1', fields: { Equipment: 'Forklift', Due: day(2, now), Status: 'Scheduled' } },
    { id: 'recJ2', fields: { Equipment: 'Generator', Due: day(-89, now), Status: 'Done' } },
  ];
}

/** seed(base, table, records) puts a table's records in place, alone. */
async function reset(seed, now = Date.now()) {
  await seed('appFACILITIES', 'tblEQUIPMENT', equipment(now));
  await seed('appFACILITIES', 'tblJOBS', jobs(now));
}

module.exports = { BASES, DAY, firstMorning, day, equipment, jobs, reset };
