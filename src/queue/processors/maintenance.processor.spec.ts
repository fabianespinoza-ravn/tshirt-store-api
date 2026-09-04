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

  it.todo('runs the sweep when the job is the one it answers to');
  it.todo('returns what the sweep reported, unchanged');
  it.todo(
    'throws on a job name it does not recognise, rather than ignoring it',
  );
  it.todo(
    'names the unrecognised job in the error, so the failed entry says what it was',
  );

  void sweep;
  void processor;
  void aJob;
  void JobName;
});
