import type { Queue } from 'bullmq';
import { JobName, SWEEP_EVERY_MS } from './queue.constants';
import { SweepScheduler, SWEEP_SCHEDULER_ID } from './sweep.scheduler';

/**
 * The case that matters here is the stable id.
 *
 * `upsertJobScheduler` replaces the schedule registered under a given id and
 * adds a new one under any other, so an id that varied — a timestamp, a
 * random value, anything derived from the process — would leave one more
 * sweep running after every deploy, each doing the same work over the same
 * expired orders. That is the one failure this class can produce, it is
 * invisible until production has been redeployed a few times, and nothing
 * else in the suite would notice it.
 *
 * The interval is worth pinning for a duller reason: it is the number the
 * whole expiry story depends on, and reading it from the constant rather
 * than repeating 60000 is what keeps the test honest when it changes.
 */
describe('SweepScheduler', () => {
  const queue = {
    upsertJobScheduler: jest.fn(),
  };
  const scheduler = new SweepScheduler(queue as unknown as Queue);

  beforeEach(() => jest.clearAllMocks());

  it('registers the sweep when the application boots', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('registers it under a stable id, so a reboot replaces rather than adds', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      SWEEP_SCHEDULER_ID,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('asks for the interval the constant declares', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      expect.any(String),
      { every: SWEEP_EVERY_MS },
      expect.any(Object),
    );
  });

  it('names the job the maintenance processor answers to', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { name: JobName.SweepExpiredOrders },
    );
  });
});
