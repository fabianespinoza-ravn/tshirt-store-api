import type { Queue } from 'bullmq';
import { JobName } from '../queue/queue.constants';
import { MailKind, type MailJobData } from './mail.jobs';
import { MailService } from './mail.service';

/**
 * What this service does is one line per method, so what is worth asserting
 * is the payload rather than the machinery.
 *
 * The case that carries weight is the negative one: the two methods that
 * take no token must enqueue a job **without a `token` field**, not one
 * with `token: undefined` that a later change could quietly fill. And every
 * job goes on the queue under the name the processor answers to — a
 * mismatch there means the mail is enqueued, never consumed, and nothing
 * anywhere reports a problem, because a job waiting in a queue is not an
 * error.
 */
describe('MailService', () => {
  const queue = { add: jest.fn() };
  const service = new MailService(queue as unknown as Queue<MailJobData>);

  beforeEach(() => jest.clearAllMocks());

  it.todo('enqueues the verification message with its token');
  it.todo('enqueues the password reset with its token');
  it.todo('enqueues the sign-in reminder with no token at all');
  it.todo('enqueues the password-changed notice with no token at all');
  it.todo('names every job the one the mail processor answers to');
  it.todo('rejects when the queue does, so a sign-up cannot report success');

  void queue;
  void service;
  void JobName;
  void MailKind;
});
