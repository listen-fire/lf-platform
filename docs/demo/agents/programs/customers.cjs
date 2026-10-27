// The stand-in world both sides of the recording are built from: the CRM's
// customers (what the fake CRM MCP server answers) and the same customers as
// Stripe holds them (what the fake Stripe sender's events carry). Three on
// each day pay from a billing address that is not the one in the CRM; every
// Stripe subscription carries the CRM's id in its metadata (`crm_id`), as a
// CRM sync sets it when the subscription is created.
//
// [crm_id, contact, company, crm email, plan, account manager, stripe billing email or null (same as CRM), day]
const ROWS = [
  ['C-10412', 'Dana Whitlock', 'Northlight Bakery', 'dana@northlightbakery.com', 'monthly', 'Priya Raman', 'accounts@northlightbakery.com', 1],
  ['C-10418', 'Owen Garside', 'Garside Joinery', 'owen@garsidejoinery.co.uk', 'monthly', 'Tom Ellery', null, 1],
  ['C-10425', 'Leila Haddad', 'Haddad Physio', 'leila@haddadphysio.com', 'yearly', 'Grace Adeyemi', null, 1],
  ['C-10431', 'Ravi Menon', 'Menon & Co Accountants', 'ravi@menonco.com', 'monthly', 'Marcus Lind', null, 1],
  ['C-10437', 'Hannah Kerr', 'Kerr Studio', 'hannah@kerrstudio.design', 'monthly', 'Priya Raman', null, 1],
  ['C-10442', 'Felix Brandt', 'Brandt Cycles', 'felix@brandtcycles.de', 'yearly', 'Tom Ellery', null, 1],
  ['C-10450', 'Amara Okonkwo', 'Okonkwo Legal', 'amara@okonkwolegal.com', 'yearly', 'Grace Adeyemi', 'billing@okonkwolegal.com', 1],
  ['C-10456', 'Sean Doyle', 'Doyle Plumbing & Heating', 'sean@doyleplumbing.ie', 'monthly', 'Marcus Lind', null, 1],
  ['C-10463', 'Mei Lin Tan', 'Tan Botanicals', 'meilin@tanbotanicals.com', 'monthly', 'Priya Raman', null, 1],
  ['C-10469', 'Jonas Eriksson', 'Fjord Coffee Roasters', 'jonas@fjordcoffee.se', 'yearly', 'Tom Ellery', null, 1],
  ['C-10474', 'Chloe Martin', 'Martin Veterinary', 'chloe@martinvets.co.uk', 'monthly', 'Grace Adeyemi', null, 1],
  ['C-10480', 'Diego Alvarez', 'Alvarez Tiles', 'diego@alvareztiles.es', 'monthly', 'Marcus Lind', null, 1],
  ['C-10486', 'Ruth Abernathy', 'Abernathy Books', 'ruth@abernathybooks.com', 'monthly', 'Priya Raman', 'ruth.abernathy@outlook.com', 1],
  ['C-10491', 'Kwame Asante', 'Asante Architecture', 'kwame@asantearch.com', 'yearly', 'Tom Ellery', null, 1],
  ['C-10497', 'Isla Fraser', 'Fraser Yoga', 'isla@fraseryoga.scot', 'monthly', 'Grace Adeyemi', null, 1],
  ['C-10503', 'Pavel Novak', 'Novak Translation', 'pavel@novaktranslation.cz', 'monthly', 'Marcus Lind', null, 1],
  ['C-10508', 'Grace Whitfield', 'Whitfield Florists', 'grace@whitfieldflorists.com', 'yearly', 'Priya Raman', null, 1],
  ['C-10514', 'Tariq Hussain', 'Hussain Dental', 'tariq@hussaindental.co.uk', 'monthly', 'Tom Ellery', null, 1],
  ['C-10521', 'Anna Kowalski', 'Kowalski Bridal', 'anna@kowalskibridal.pl', 'monthly', 'Grace Adeyemi', null, 1],
  ['C-10527', 'Ben Hartley', 'Hartley Brewing', 'ben@hartleybrewing.com', 'yearly', 'Marcus Lind', null, 1],
  ['C-10533', 'Sofia Rossi', 'Rossi Gelato', 'sofia@rossigelato.it', 'monthly', 'Priya Raman', null, 2],
  ['C-10538', 'Liam Gallagher', 'Gallagher Removals', 'liam@gallagherremovals.ie', 'monthly', 'Tom Ellery', 'office@gallagherremovals.ie', 2],
  ['C-10544', 'Nadia Petrova', 'Petrova Ceramics', 'nadia@petrovaceramics.com', 'yearly', 'Grace Adeyemi', null, 2],
  ['C-10549', 'Ethan Clarke', 'Clarke Surveying', 'ethan@clarkesurveying.co.uk', 'monthly', 'Marcus Lind', null, 2],
  ['C-10555', 'Yuki Tanaka', 'Tanaka Ramen Bar', 'yuki@tanakaramen.com', 'monthly', 'Priya Raman', null, 2],
  ['C-10561', 'Olivia Bennett', 'Bennett Interiors', 'olivia@bennettinteriors.com', 'yearly', 'Tom Ellery', 'finance@bennettinteriors.com', 2],
  ['C-10566', 'Marek Zielinski', 'Zielinski Motors', 'marek@zielinskimotors.pl', 'monthly', 'Grace Adeyemi', null, 2],
  ['C-10572', 'Fatima Begum', 'Begum Tailoring', 'fatima@begumtailoring.co.uk', 'monthly', 'Marcus Lind', null, 2],
  ['C-10578', 'Harry Lomax', 'Lomax Garden Design', 'harry@lomaxgardens.com', 'yearly', 'Priya Raman', null, 2],
  ['C-10583', 'Elena Vasquez', 'Vasquez Language School', 'elena@vasquezlanguages.com', 'monthly', 'Tom Ellery', null, 2],
  ['C-10589', 'Callum Reid', 'Reid Electrical', 'callum@reidelectrical.scot', 'monthly', 'Grace Adeyemi', null, 2],
  ['C-10594', 'Priscilla Ng', 'Ng Optometry', 'priscilla@ngoptometry.com', 'yearly', 'Marcus Lind', null, 2],
  ['C-10600', 'Tom Ashworth', 'Ashworth Butchers', 'tom@ashworthbutchers.co.uk', 'monthly', 'Priya Raman', null, 2],
  ['C-10605', 'Ingrid Solberg', 'Solberg Knitwear', 'ingrid@solbergknit.no', 'monthly', 'Tom Ellery', 'ingrid.solberg@gmail.com', 2],
  ['C-10611', 'Victor Mensah', 'Mensah Logistics', 'victor@mensahlogistics.com', 'yearly', 'Grace Adeyemi', null, 2],
  ['C-10617', 'Lucy Pemberton', 'Pemberton Pilates', 'lucy@pembertonpilates.com', 'monthly', 'Marcus Lind', null, 2],
  ['C-10622', 'Arjun Kapoor', 'Kapoor Pharmacy', 'arjun@kapoorpharmacy.co.uk', 'monthly', 'Priya Raman', null, 2],
  ['C-10628', 'Maeve O\'Connell', 'O\'Connell Gallery', 'maeve@oconnellgallery.ie', 'yearly', 'Tom Ellery', null, 2],
  ['C-10633', 'Daniel Weiss', 'Weiss Piano Tuning', 'daniel@weisspiano.de', 'monthly', 'Grace Adeyemi', null, 2],
  ['C-10639', 'Zara Ahmed', 'Ahmed Skincare', 'zara@ahmedskincare.com', 'monthly', 'Marcus Lind', null, 2],
];

const PRICE_CENTS = { monthly: 4900, yearly: 49000 };

// Stripe-looking ids, the same on every recording (a seeded generator).
function idMaker(seed) {
  let x = seed;
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return (prefix, length) => {
    let out = prefix;
    for (let i = 0; i < length; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      out += ALPHABET[(x >>> 16) % ALPHABET.length];
    }
    return out;
  };
}
const stripeId = idMaker(20261027);

const customers = ROWS.map(([crmId, contact, company, email, plan, accountManager, billingEmail, day], i) => ({
  crm: { crm_id: crmId, name: contact, company, email, plan, account_manager: accountManager },
  stripe: {
    id: stripeId('cus_', 14),
    email: billingEmail ?? email,
    name: company,
    subscription: stripeId('sub_1Q', 22),
    plan,
    amountCents: PRICE_CENTS[plan],
    crmId,
  },
  day,
}));

module.exports = { customers, idMaker };
