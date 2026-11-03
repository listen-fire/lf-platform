// T4's grading, called by ../../grade.cjs: `listen-fire drain --until-idle`
// with the clock moved on (LF_CLOCK_AHEAD_MS): now (the listen arms), the
// first morning 07:00:30 UTC, then, after the team has worked the jobs and
// changed two dates, the next morning. The Service Jobs table after each.
const { DAY, firstMorning, day } = require('./world.cjs');

module.exports = async function grade({ lf, expect, text, world, FAKES }) {
  const now = Date.now();
  await world.reset(FAKES, 't4', now);
  const first = firstMorning(now);
  const jobs = () => world.rows(FAKES, 'appFACILITIES', 'tblJOBS');
  const of = (rows, name) => rows.filter((r) => text(r.fields.Equipment) === name);
  const dueOf = (r) => text(r.fields.Due).slice(0, 10);
  /** The one job for `name` that is To do, due `days` from the first morning. */
  const oneToDo = (label, rows, name, days) => {
    const open = of(rows, name).filter((r) => text(r.fields.Status) !== 'Done');
    expect(`${label}: one open job for ${name}`, open.length === 1, of(rows, name).map((r) => r.fields));
    expect(`${label}: ${name}'s job is To do, due ${day(days, now)}`, open.length === 1 && text(open[0].fields.Status) === 'To do' && dueOf(open[0]) === day(days, now), open.map((r) => r.fields));
  };

  lf(['drain', '--until-idle'], 0);
  expect('no job before the first morning', (await jobs()).length === 2);

  lf(['drain', '--until-idle'], first - now);
  const morning1 = await jobs();
  expect('first morning: three jobs added', morning1.length === 5, morning1.map((r) => r.fields));
  oneToDo('first morning', morning1, 'Boiler', -3);
  oneToDo('first morning', morning1, 'Lift', 4);
  oneToDo('first morning', morning1, 'Generator', 1);
  expect('first morning: the Forklift keeps its one scheduled job', of(morning1, 'Forklift').length === 1 && text(of(morning1, 'Forklift')[0].fields.Status) === 'Scheduled', of(morning1, 'Forklift').map((r) => r.fields));
  expect('first morning: the Generator keeps its done job', of(morning1, 'Generator').some((r) => text(r.fields.Status) === 'Done'), of(morning1, 'Generator').map((r) => r.fields));
  for (const name of ['Fire alarm panel', 'Old compressor', 'Projector']) expect(`first morning: no job for ${name}`, of(morning1, name).length === 0, of(morning1, name).map((r) => r.fields));

  // The team's day: the Boiler's job is booked, the Lift serviced (its next
  // service a quarter on), the fire alarm panel's inspection brought forward.
  const patch = (table, id, fields) => world.call(FAKES, 'PATCH', `/airtable/v0/appFACILITIES/${table}/${id}`, { fields });
  const job = (name) => of(morning1, name).find((r) => text(r.fields.Status) === 'To do');
  if (job('Boiler')) await patch('tblJOBS', job('Boiler').id, { Status: 'Scheduled' });
  if (job('Lift')) await patch('tblJOBS', job('Lift').id, { Status: 'Done' });
  await patch('tblEQUIPMENT', 'recQ2', { 'Next Service': day(95, now) });
  await patch('tblEQUIPMENT', 'recQ3', { 'Next Service': day(3, now) });

  lf(['drain', '--until-idle'], first + DAY - now);
  const morning2 = await jobs();
  expect('next morning: one job added', morning2.length === 6, morning2.map((r) => r.fields));
  oneToDo('next morning', morning2, 'Fire alarm panel', 3);
  oneToDo('next morning', morning2, 'Generator', 1);
  expect("next morning: the Boiler's job is still Scheduled, and its only one", of(morning2, 'Boiler').length === 1 && text(of(morning2, 'Boiler')[0].fields.Status) === 'Scheduled', of(morning2, 'Boiler').map((r) => r.fields));
  expect('next morning: no new job for the serviced Lift', of(morning2, 'Lift').length === 1 && text(of(morning2, 'Lift')[0].fields.Status) === 'Done', of(morning2, 'Lift').map((r) => r.fields));
  expect('next morning: the Forklift still has its one scheduled job', of(morning2, 'Forklift').length === 1, of(morning2, 'Forklift').map((r) => r.fields));
};
