import type { Queue } from 'bullmq';
import { CONFIRMATION_OUTBOX_DRAIN_EVERY_MS, JobName } from './queue.constants';
import {
  CONFIRMATION_OUTBOX_SCHEDULER_ID,
  ConfirmationOutboxScheduler,
} from './confirmation-outbox.scheduler';

/**
 * The same case `sweep.scheduler.spec.ts` makes for its own scheduler,
 * carried over unchanged: a scheduler id that varied between boots would
 * leave one more drain running after every deploy rather than replacing the
 * last one, and nothing else in the suite would notice it.
 *
 * Stubs only — this scheduler is new code from this session, and asserting
 * it correct (`upsertJobScheduler` called with `CONFIRMATION_OUTBOX_SCHEDULER_ID`,
 * `{ every: CONFIRMATION_OUTBOX_DRAIN_EVERY_MS }` and
 * `{ name: JobName.DrainConfirmationOutbox }`, the same way
 * `SweepScheduler.spec.ts` asserts its own scheduler) is the student's to
 * do, per this repo's CLAUDE.md.
 */
describe('ConfirmationOutboxScheduler', () => {
  const queue = {
    upsertJobScheduler: jest.fn(),
  };
  const scheduler = new ConfirmationOutboxScheduler(queue as unknown as Queue);

  beforeEach(() => jest.clearAllMocks());

  it('registers the drain when the application boots', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('registers it under a stable id, so a reboot replaces rather than adds', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      CONFIRMATION_OUTBOX_SCHEDULER_ID,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('asks for the interval CONFIRMATION_OUTBOX_DRAIN_EVERY_MS declares', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      expect.any(String),
      { every: CONFIRMATION_OUTBOX_DRAIN_EVERY_MS },
      expect.any(Object),
    );
  });

  it('names the job the confirmation outbox processor answers to', async () => {
    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { name: JobName.DrainConfirmationOutbox },
    );
  });
});
