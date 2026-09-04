import type { Job } from 'bullmq';
import type { OrdersSweepService } from '../../orders/orders-sweep.service';
import { JobName } from '../queue.constants';
import { MaintenanceProcessor } from './maintenance.processor';

/**
 * One case here is worth more than the rest: an unrecognised job name has to
 * **throw**, not be quietly ignored.
 *
 * A processor that returns silently on a name it does not know is how a
 * renamed job stops running while every dashboard still shows the queue as
 * healthy and empty — the work simply stops happening and nothing says so.
 * Throwing puts the job in the failed set, which `removeOnFail: false` keeps,
 * where somebody can read what it was.
 *
 * The rest is delegation, and the only thing worth pinning about it is that
 * the processor holds no logic of its own: whatever the sweep returns is
 * what the job returns, so a future reader knows where to look.
 */
describe('MaintenanceProcessor', () => {
  const sweep = { sweep: jest.fn() };
  const processor = new MaintenanceProcessor(
    sweep as unknown as OrdersSweepService,
  );

  const aJob = (name: string): Job => ({ name }) as Job;

  beforeEach(() => jest.clearAllMocks());

  it('runs the sweep when the job is the one it answers to', async () => {
    sweep.sweep.mockResolvedValue({ examined: 2, cancelled: 1 });

    await processor.process(aJob(JobName.SweepExpiredOrders));

    expect(sweep.sweep).toHaveBeenCalledWith();
  });

  it('returns what the sweep reported, unchanged', async () => {
    const outcome = { examined: 2, cancelled: 1 };
    sweep.sweep.mockResolvedValue(outcome);

    await expect(
      processor.process(aJob(JobName.SweepExpiredOrders)),
    ).resolves.toBe(outcome);
  });

  it('throws on a job name it does not recognise, rather than ignoring it', async () => {
    await expect(processor.process(aJob('renamed-job'))).rejects.toThrow();
    expect(sweep.sweep).not.toHaveBeenCalled();
  });

  it('names the unrecognised job in the error, so the failed entry says what it was', async () => {
    await expect(processor.process(aJob('renamed-job'))).rejects.toThrow(
      'Unknown maintenance job: renamed-job',
    );
  });
});
