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
  it.todo('registers the drain when the application boots');
  it.todo(
    'registers it under a stable id, so a reboot replaces rather than adds',
  );
  it.todo('asks for the interval CONFIRMATION_OUTBOX_DRAIN_EVERY_MS declares');
  it.todo('names the job the confirmation outbox processor answers to');
});
