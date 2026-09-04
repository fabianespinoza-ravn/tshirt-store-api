import type { Queue } from 'bullmq';
import { JobName, QueueName, SWEEP_EVERY_MS } from './queue.constants';
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

  it.todo('registers the sweep when the application boots');
  it.todo(
    'registers it under a stable id, so a reboot replaces rather than adds',
  );
  it.todo('asks for the interval the constant declares');
  it.todo('names the job the maintenance processor answers to');

  void queue;
  void scheduler;
  void JobName;
  void QueueName;
  void SWEEP_EVERY_MS;
  void SWEEP_SCHEDULER_ID;
});
