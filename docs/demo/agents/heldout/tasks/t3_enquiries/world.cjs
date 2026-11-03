// T3's part of the second world: the Events base, its Clients (looked up by
// email) and its Enquiries (written to). One enquiry is there already and is
// never touched.
const BASES = {
  appEVENTS: {
    name: 'Events',
    tables: {
      tblCLIENTS: {
        name: 'Clients',
        primaryFieldId: 'fldCompany',
        fields: [
          { id: 'fldCompany', name: 'Company', type: 'singleLineText' },
          { id: 'fldCEmail', name: 'Email', type: 'email' },
          { id: 'fldManager', name: 'Account Manager', type: 'singleLineText' },
        ],
      },
      tblENQUIRIES: {
        name: 'Enquiries',
        primaryFieldId: 'fldEnqId',
        fields: [
          { id: 'fldEnqId', name: 'Enquiry Id', type: 'singleLineText' },
          { id: 'fldEName', name: 'Name', type: 'singleLineText' },
          { id: 'fldEEmail', name: 'Email', type: 'email' },
          { id: 'fldEDate', name: 'Event Date', type: 'date' },
          { id: 'fldGuests', name: 'Guests', type: 'number', options: { precision: 0 } },
          { id: 'fldAssigned', name: 'Assigned To', type: 'singleLineText' },
          {
            id: 'fldPriority',
            name: 'Priority',
            type: 'singleSelect',
            options: { choices: ['Urgent', 'High', 'Normal'].map((name, i) => ({ id: `selP${i}`, name })) },
          },
        ],
      },
    },
  },
};

const CLIENTS = [
  { id: 'recC1', fields: { Company: 'Brightside Studio', Email: 'ana@brightside.co', 'Account Manager': 'Marco' } },
  { id: 'recC2', fields: { Company: 'Northwind Labs', Email: 'ben@northwind.io', 'Account Manager': 'Lucia' } },
  { id: 'recC3', fields: { Company: 'Kestrel Partners', Email: 'events@kestrel.vc', 'Account Manager': 'Marco' } },
];

const EARLIER = { id: 'recE0', fields: { 'Enquiry Id': 'enq_0999', Name: 'Ola Berg', Email: 'ola@fjord.no', 'Event Date': '2026-09-30', Guests: 40, 'Assigned To': 'Dana', Priority: 'Normal' } };

/** seed(base, table, records) puts a table's records in place, alone. */
async function reset(seed) {
  await seed('appEVENTS', 'tblCLIENTS', CLIENTS);
  await seed('appEVENTS', 'tblENQUIRIES', [EARLIER]);
}

module.exports = { BASES, CLIENTS, EARLIER, reset };
