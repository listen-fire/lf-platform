// The held-out tasks' stand-in world in fake-channels' Airtable: two bases a
// team would have, Community (T1's Members) and Support (T2's Tickets and
// Digests). Both tasks see both bases, as one Airtable account would show
// them. Records hold their fields by name, as Airtable answers them and as
// @lf/airtable writes them; `rows` also maps any field id back to its name.
//
//   node world.cjs <fakes url> setup          the bases and tables, the fake's
//                                               default bases removed
//   node world.cjs <fakes url> reset <t1|t2>  that task's records as seeded
//   node world.cjs <fakes url> rows <base> <table>
const BASES = {
  appCOMMUNITY: {
    name: 'Community',
    tables: {
      tblMEMBERS: {
        name: 'Members',
        primaryFieldId: 'fldTgId',
        fields: [
          { id: 'fldTgId', name: 'Telegram Id', type: 'singleLineText' },
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldUser', name: 'Username', type: 'singleLineText' },
          { id: 'fldLast', name: 'Last Message', type: 'multilineText' },
          { id: 'fldStatus', name: 'Status', type: 'singleSelect', options: { choices: [{ id: 'selActive', name: 'Active' }, { id: 'selUnsub', name: 'Unsubscribed' }] } },
        ],
      },
    },
  },
  appSUPPORT: {
    name: 'Support',
    tables: {
      tblTICKETS: {
        name: 'Tickets',
        primaryFieldId: 'fldTitle',
        fields: [
          { id: 'fldTitle', name: 'Title', type: 'singleLineText' },
          {
            id: 'fldTStatus',
            name: 'Status',
            type: 'singleSelect',
            options: { choices: ['Open', 'In progress', 'Waiting', 'Done'].map((name, i) => ({ id: `selT${i}`, name })) },
          },
          { id: 'fldAssignee', name: 'Assignee', type: 'singleLineText' },
        ],
      },
      tblDIGESTS: {
        name: 'Digests',
        primaryFieldId: 'fldDate',
        fields: [
          { id: 'fldDate', name: 'Date', type: 'date' },
          { id: 'fldOpen', name: 'Open Tickets', type: 'number', options: { precision: 0 } },
          { id: 'fldBreakdown', name: 'Breakdown', type: 'multilineText' },
        ],
      },
    },
  },
};

// T1: two members already in the table. Grace unsubscribed earlier; Linus is
// never written to.
const MEMBERS = [
  { id: 'recGRACE', fields: { 'Telegram Id': '2002', Name: 'Grace', Username: 'grace_h', 'Last Message': '/stop', Status: 'Unsubscribed' } },
  { id: 'recLINUS', fields: { 'Telegram Id': '2003', Name: 'Linus', Username: 'linus_t', 'Last Message': 'thanks!', Status: 'Active' } },
];

// T2: the tickets before the first Monday (state A). An unassigned ticket has
// no Assignee at all, as Airtable answers an empty cell.
const ticket = (id, title, status, assignee) => ({ id, fields: { Title: title, Status: status, ...(assignee ? { Assignee: assignee } : {}) } });
const TICKETS = [
  ticket('recT01', 'Login loop on Safari', 'Open', 'Priya'),
  ticket('recT02', 'Invoice PDF blank', 'In progress', 'Priya'),
  ticket('recT03', 'Export times out', 'Done', 'Priya'),
  ticket('recT04', 'SSO for Contoso', 'Waiting', 'Priya'),
  ticket('recT05', 'Webhook retries', 'Open', 'Tom'),
  ticket('recT06', 'Typo on pricing page', 'Done', 'Tom'),
  ticket('recT07', 'Password reset email late', 'Done', 'Lena'),
  ticket('recT08', 'CSV import encoding', 'Done', 'Lena'),
  ticket('recT09', 'Dark mode contrast', 'Open', null),
  ticket('recT10', 'Refund request #4411', 'Open', null),
  ticket('recT11', 'API key rotation question', 'Waiting', null),
  ticket('recT12', 'Slow dashboard', 'In progress', 'Sam'),
];

async function call(fakes, method, path, body) {
  const res = await fetch(`${fakes}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function setup(fakes) {
  for (const base of await call(fakes, 'GET', '/admin/airtable/base/state')) await call(fakes, 'DELETE', `/admin/airtable/table:${base.id}/state`);
  await call(fakes, 'DELETE', '/admin/airtable/base/state');
  const entities = [];
  for (const [baseId, base] of Object.entries(BASES)) {
    entities.push({ entity_type: 'base', id: baseId, data: { id: baseId, name: base.name, permissionLevel: 'create' } });
    for (const [tableId, table] of Object.entries(base.tables)) {
      entities.push({ entity_type: `table:${baseId}`, id: tableId, data: { id: tableId, name: table.name, primaryFieldId: table.primaryFieldId, fields: table.fields } });
    }
  }
  await call(fakes, 'POST', '/admin/airtable/seed', { entities });
}

async function seedRecords(fakes, baseId, tableId, records) {
  await call(fakes, 'DELETE', `/admin/airtable/record:${baseId}:${tableId}/state`);
  const at = '2026-10-01T09:00:00.000Z';
  await call(fakes, 'POST', '/admin/airtable/seed', { entities: records.map((r) => ({ entity_type: `record:${baseId}:${tableId}`, id: r.id, data: { id: r.id, fields: r.fields, createdTime: at } })) });
}

async function reset(fakes, task) {
  if (task === 't1') return seedRecords(fakes, 'appCOMMUNITY', 'tblMEMBERS', MEMBERS);
  if (task === 't2') {
    await seedRecords(fakes, 'appSUPPORT', 'tblTICKETS', TICKETS);
    return seedRecords(fakes, 'appSUPPORT', 'tblDIGESTS', []);
  }
  throw new Error(`no task ${task}`);
}

/** A table's records, each field under its name (the fake keeps what the
 *  module sent: by id, or by name). */
async function rows(fakes, baseId, tableId) {
  const names = new Map(BASES[baseId].tables[tableId].fields.map((f) => [f.id, f.name]));
  const records = await call(fakes, 'GET', `/admin/airtable/record:${baseId}:${tableId}/state`);
  return records.map((r) => ({ id: r.id, fields: Object.fromEntries(Object.entries(r.fields ?? {}).map(([k, v]) => [names.get(k) ?? k, v])) }));
}

/** T2's change between the two Mondays (state B). */
async function changeTickets(fakes) {
  const patch = (id, fields) => call(fakes, 'PATCH', `/airtable/v0/appSUPPORT/tblTICKETS/${id}`, { fields });
  await patch('recT05', { Status: 'Done' });
  await patch('recT04', { Status: 'Done' });
  await patch('recT09', { Assignee: 'Sam' });
  await call(fakes, 'POST', '/airtable/v0/appSUPPORT/tblTICKETS', { fields: { Title: 'Billing address change', Status: 'Open', Assignee: 'Lena' } });
}

module.exports = { BASES, MEMBERS, TICKETS, setup, reset, rows, changeTickets };

if (require.main === module) {
  const [fakes, what, ...rest] = process.argv.slice(2);
  const done = (p) => p.then((v) => v !== undefined && console.log(JSON.stringify(v, null, 1))).catch((e) => (console.error(e.message), process.exit(1)));
  if (what === 'setup') done(setup(fakes));
  else if (what === 'reset') done(reset(fakes, rest[0]));
  else if (what === 'rows') done(rows(fakes, rest[0], rest[1]));
  else (console.error('setup | reset <t1|t2> | rows <base> <table>'), process.exit(2));
}
