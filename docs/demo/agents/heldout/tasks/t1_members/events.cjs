// T1's Telegram updates, as Telegram posts them to the bot's webhook, and each
// as `listen-fire run --event` takes it: the arrival @lf/telegram's door makes
// of it, by the module's own code (modules/telegram/inbound.ts).
//
//   node events.cjs <listen-fire checkout> <out dir>
// writes example.update.json / example.json (the authoring session's example)
// and 01.json … 04.json (the grader's events, in order).
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const update = (n, user, text) => ({
  update_id: 880000 + n,
  message: {
    message_id: 500 + n,
    date: 1_793_000_000 + n * 60,
    chat: { id: user.id, type: 'private', first_name: user.first_name, ...(user.username ? { username: user.username } : {}) },
    from: { id: user.id, is_bot: false, first_name: user.first_name, ...(user.username ? { username: user.username } : {}), language_code: 'en' },
    text,
  },
});

const MAYA = { id: 3001, first_name: 'Maya', username: 'maya_k' };
const ADA = { id: 1001, first_name: 'Ada', username: 'ada' };
const GRACE = { id: 2002, first_name: 'Grace', username: 'grace_h' };
const KEN = { id: 1004, first_name: 'Ken' };

const EXAMPLE = update(0, MAYA, 'hey there');
const EVENTS = [update(1, ADA, 'hello'), update(2, GRACE, "I'm back!"), update(3, ADA, '/stop'), update(4, KEN, 'hi')];

// What the Members table must hold after the four events, by Telegram Id.
// Name is the sender's first name; Username is absent or empty for Ken, who
// has none. Linus (2003) is never written to.
const EXPECTED = {
  1001: { Name: 'Ada', Username: 'ada', 'Last Message': '/stop', Status: 'Unsubscribed' },
  1004: { Name: 'Ken', Username: '', 'Last Message': 'hi', Status: 'Active' },
  2002: { Name: 'Grace', Username: 'grace_h', 'Last Message': "I'm back!", Status: 'Active' },
  2003: { Name: 'Linus', Username: 'linus_t', 'Last Message': 'thanks!', Status: 'Active' },
};

module.exports = { EXAMPLE, EVENTS, EXPECTED };

if (require.main === module) {
  const [lfSrc, out] = process.argv.slice(2);
  createRequire(path.join(lfSrc, 'packages/module-kit/package.json'))('tsx/cjs');
  const { telegramInboundArrivals } = require(path.join(lfSrc, 'modules/telegram/inbound.ts'));
  const asEvent = (u) => {
    const arrivals = telegramInboundArrivals(u);
    if (arrivals.length !== 1) throw new Error(`update ${u.update_id} is not one arrival`);
    return { external: 'telegram', event: { arrivals } };
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'example.update.json'), `${JSON.stringify(EXAMPLE, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'example.json'), JSON.stringify(asEvent(EXAMPLE)));
  EVENTS.forEach((u, i) => fs.writeFileSync(path.join(out, `${String(i + 1).padStart(2, '0')}.json`), JSON.stringify(asEvent(u))));
}
