import { captureEngineLogs } from '../../../test/engine_logs';
import { WAKE_WAIT_MS, announceWork, installWake, resetWakeForTests, settleWakes, wakeInstalled, type WakeSlot } from '../wake';

const logs = captureEngineLogs();

interface Told {
  call: 'now' | 'at';
  kind: string;
  at?: Date;
}

function recordingSlot(answer: () => Promise<void> = async () => {}): { slot: WakeSlot; told: Told[] } {
  const told: Told[] = [];
  return {
    told,
    slot: {
      now(kind) {
        told.push({ call: 'now', kind });
        return answer();
      },
      at(kind, at) {
        told.push({ call: 'at', kind, at });
        return answer();
      },
    },
  };
}

const NOW = new Date('2026-10-23T12:00:30.000Z');
const notToldLines = () => logs.messages('warn').filter((message) => message.startsWith('[work] the wake was not told'));

afterEach(() => {
  resetWakeForTests();
  jest.restoreAllMocks();
});

describe('announceWork', () => {
  it('with no wake installed nothing is called', async () => {
    const { slot, told } = recordingSlot();
    installWake(slot);
    installWake(undefined);
    expect(wakeInstalled()).toBe(false);
    const started = Date.now();
    await announceWork('fire_cron', new Date(NOW.getTime() + 60_000), NOW);
    await announceWork('fire_cron', NOW, NOW);
    expect(Date.now() - started).toBeLessThan(50);
    expect(told).toEqual([]);
    expect(logs.lines()).toEqual([]);
  });

  it('a row due in the past is announced now, a future one at its due time', async () => {
    const { slot, told } = recordingSlot();
    installWake(slot);
    expect(wakeInstalled()).toBe(true);
    const future = new Date(NOW.getTime() + 90_000);
    await announceWork('resume_timer', new Date(NOW.getTime() - 5_000), NOW);
    await announceWork('resume_timer', NOW, NOW);
    await announceWork('poll_source', future, NOW);
    expect(told).toEqual([
      { call: 'now', kind: 'resume_timer' },
      { call: 'now', kind: 'resume_timer' },
      { call: 'at', kind: 'poll_source', at: future },
    ]);
  });

  it('a failure is logged once a minute and never thrown', async () => {
    let clock = NOW.getTime();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    let throwSync = false;
    const slot: WakeSlot = {
      now: () => {
        if (throwSync) throw new Error('thrown before answering');
        return Promise.reject(new Error('Cloud Tasks answered 503 UNAVAILABLE to a task create'));
      },
      at: () => Promise.reject(new Error('Cloud Tasks answered 503 UNAVAILABLE to a task create')),
    };
    installWake(slot);

    await expect(announceWork('slack_event', NOW, NOW)).resolves.toBeUndefined();
    await expect(announceWork('slack_event', NOW, NOW)).resolves.toBeUndefined();
    await expect(announceWork('fire_cron', new Date(NOW.getTime() + 60_000), NOW)).resolves.toBeUndefined();
    expect(notToldLines()).toEqual([
      '[work] the wake was not told of slack_event work (Cloud Tasks answered 503 UNAVAILABLE to a task create); a scheduled drain will find it',
    ]);

    clock += 59_000;
    throwSync = true;
    await expect(announceWork('slack_event', NOW, NOW)).resolves.toBeUndefined();
    expect(notToldLines()).toHaveLength(1);

    clock += 1_000;
    await expect(announceWork('slack_event', NOW, NOW)).resolves.toBeUndefined();
    expect(notToldLines()).toEqual([
      '[work] the wake was not told of slack_event work (Cloud Tasks answered 503 UNAVAILABLE to a task create); a scheduled drain will find it',
      '[work] the wake was not told of slack_event work (thrown before answering); a scheduled drain will find it',
    ]);
  });

  it('a slot slower than WAKE_WAIT_MS is left running and settleWakes waits for it', async () => {
    let answered = false;
    let answer: () => void = () => {};
    const { slot, told } = recordingSlot(
      () =>
        new Promise<void>((resolve) => {
          answer = () => {
            answered = true;
            resolve();
          };
        }),
    );
    installWake(slot);

    const started = Date.now();
    await announceWork('fire_callback', NOW, NOW);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(WAKE_WAIT_MS - 20);
    expect(waited).toBeLessThan(WAKE_WAIT_MS + 500);
    expect(told).toHaveLength(1);
    expect(answered).toBe(false);
    expect(notToldLines()).toEqual([
      `[work] the wake was not told of fire_callback work (no answer within ${WAKE_WAIT_MS} ms; the call carries on); a scheduled drain will find it`,
    ]);

    setTimeout(() => answer(), 200);
    const settling = Date.now();
    await settleWakes(5_000);
    expect(answered).toBe(true);
    expect(Date.now() - settling).toBeLessThan(2_000);

    // Nothing in flight: settling returns at once.
    const idle = Date.now();
    await settleWakes(5_000);
    expect(Date.now() - idle).toBeLessThan(50);
  });

  it('settleWakes gives up at its timeout on a call that never answers', async () => {
    installWake(recordingSlot(() => new Promise<void>(() => {})).slot);
    await announceWork('fire_callback', NOW, NOW);
    const started = Date.now();
    await settleWakes(300);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
