// The scripted page held to the browser slot's contract (the built-in
// Chromium is held to it in apps/api), and the empty slot's refusal.

import { BrowserSlotEmpty, emptyBrowserSlot } from '../browser';
import { browserContractCases, type ContractSite } from '../contract';
import { fakeBrowser, type FakeSite } from '../fake_browser';

const SITE: ContractSite = { url: 'https://contract.test/page', title: 'Browser contract', heading: 'Hello' };

const site: FakeSite = {
  open(url) {
    if (url !== SITE.url) throw new Error(`fake site: nothing at ${url}`);
    return { title: () => SITE.title, query: (selector) => (selector === 'h1' ? [{ text: SITE.heading }] : []) };
  },
};

describe('the scripted page (fake browser)', () => {
  for (const contractCase of browserContractCases) {
    it(contractCase.name, () => contractCase.run((limits) => fakeBrowser(site, limits).slot, SITE));
  }

  it('closes the browser of every session, whether it answered or threw', async () => {
    const browser = fakeBrowser(site);
    await browser.slot.withPage(async () => 1);
    await expect(browser.slot.withPage(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(browser.closed()).toBe(2);
  });
});

describe('the empty browser slot', () => {
  it('refuses every session, naming the slot and why it is empty', async () => {
    const slot = emptyBrowserSlot('this is the api-slim image; run ghcr.io/listen-fire/api');
    await expect(slot.withPage(async () => 1)).rejects.toThrow(BrowserSlotEmpty);
    await expect(slot.withPage(async () => 1)).rejects.toThrow(
      'the browser slot is empty: this is the api-slim image; run ghcr.io/listen-fire/api',
    );
  });
});
