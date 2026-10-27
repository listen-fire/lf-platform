// node make_invoices.cjs <chrome> <out dir>: the two suppliers' invoices as
// born-digital PDFs with a real text layer, printed by headless Chrome from
// the HTML this script writes. Each invoice's figures are its own JSON
// (paperworks.json, ashdown.json); the totals are summed here, never typed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [chrome, out] = process.argv.slice(2);
if (!chrome || !out) {
  console.error('usage: node make_invoices.cjs <chrome binary> <out dir>');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const money = (n) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function html(inv) {
  const lines = inv.lines.map((l) => ({ ...l, amount: Math.round(l.qty * l.unit * 100) / 100 }));
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const vat = Math.round(net * inv.vatRate * 100) / 100;
  const total = net + vat;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.supplier.name)} invoice ${esc(inv.number)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1d1d1f; font-size: 10.5pt; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${inv.accent}; padding-bottom: 10px; }
  .brand { font-size: 20pt; font-weight: 700; color: ${inv.accent}; }
  .muted { color: #555; line-height: 1.45; }
  h1 { font-size: 22pt; margin: 0; letter-spacing: 0.04em; text-align: right; }
  .meta { margin-top: 18px; display: flex; justify-content: space-between; }
  .meta table td { padding: 2px 0 2px 14px; }
  .meta table td:first-child { color: #555; padding-left: 0; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 26px; }
  table.lines th { text-align: left; border-bottom: 1px solid #999; padding: 6px 4px; font-size: 9.5pt; text-transform: uppercase; color: #444; }
  table.lines td { padding: 7px 4px; border-bottom: 1px solid #e3e3e3; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-top: 14px; margin-left: auto; width: 46%; border-collapse: collapse; }
  .totals td { padding: 4px; }
  .totals tr.grand td { border-top: 2px solid #1d1d1f; font-weight: 700; font-size: 12.5pt; }
  .foot { margin-top: 34px; border-top: 1px solid #ccc; padding-top: 10px; font-size: 9pt; }
</style></head><body>
<div class="top">
  <div><div class="brand">${esc(inv.supplier.name)}</div>
    <div class="muted">${inv.supplier.address.map(esc).join('<br>')}<br>${esc(inv.supplier.email)} · ${esc(inv.supplier.phone)}<br>VAT reg. ${esc(inv.supplier.vat)}</div></div>
  <div><h1>INVOICE</h1></div>
</div>
<div class="meta">
  <div><div class="muted">Bill to</div><strong>${esc(inv.customer.name)}</strong><br><span class="muted">${inv.customer.address.map(esc).join('<br>')}</span></div>
  <table>
    <tr><td>Invoice number</td><td><strong>${esc(inv.number)}</strong></td></tr>
    <tr><td>Invoice date</td><td>${longDate(inv.date)}</td></tr>
    <tr><td>Due date</td><td>${longDate(inv.due)}</td></tr>
    <tr><td>Your reference</td><td>${esc(inv.po)}</td></tr>
  </table>
</div>
<table class="lines">
  <tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
  ${lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unit)}</td><td class="num">${money(l.amount)}</td></tr>`).join('\n  ')}
</table>
<table class="totals">
  <tr><td>Subtotal</td><td class="num">${money(net)}</td></tr>
  <tr><td>VAT at ${Math.round(inv.vatRate * 100)}%</td><td class="num">${money(vat)}</td></tr>
  <tr class="grand"><td>Total due (GBP)</td><td class="num">${money(total)}</td></tr>
</table>
<div class="foot muted">Payment terms: ${esc(inv.terms)}. Please pay by bank transfer to ${esc(inv.supplier.bank)}, quoting ${esc(inv.number)}.<br>${esc(inv.supplier.company)}</div>
</body></html>`;
}

for (const name of ['paperworks', 'ashdown']) {
  const inv = JSON.parse(fs.readFileSync(path.join(__dirname, `${name}.json`), 'utf8'));
  const page = path.join(out, `${name}.html`);
  fs.writeFileSync(page, html(inv));
  const pdf = path.join(out, inv.file);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-first-run', `--user-data-dir=${path.join(out, '.chrome')}`,
    `--print-to-pdf=${pdf}`, `file://${page}`,
  ], { stdio: 'ignore' });
  console.log(pdf);
}
