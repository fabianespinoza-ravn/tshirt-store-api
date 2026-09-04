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

  it('enqueues the verification message with its token', async () => {
    await service.sendVerificationLink('verify@example.test', 'verify-token');

    expect(queue.add).toHaveBeenCalledWith(JobName.SendMail, {
      kind: MailKind.Verification,
      to: 'verify@example.test',
      token: 'verify-token',
    });
  });

  it('enqueues the password reset with its token', async () => {
    await service.sendPasswordReset('reset@example.test', 'reset-token');

    expect(queue.add).toHaveBeenCalledWith(JobName.SendMail, {
      kind: MailKind.PasswordReset,
      to: 'reset@example.test',
      token: 'reset-token',
    });
  });

  it('enqueues the sign-in reminder with no token at all', async () => {
    await service.sendSignInReminder('signin@example.test');

    expect(queue.add).toHaveBeenCalledWith(JobName.SendMail, {
      kind: MailKind.SignInReminder,
      to: 'signin@example.test',
    });
  });

  it('enqueues the password-changed notice with no token at all', async () => {
    await service.sendPasswordChanged('changed@example.test');

    expect(queue.add).toHaveBeenCalledWith(JobName.SendMail, {
      kind: MailKind.PasswordChanged,
      to: 'changed@example.test',
    });
  });

  it('names every job the one the mail processor answers to', async () => {
    await service.sendVerificationLink('verify@example.test', 'verify-token');
    await service.sendPasswordReset('reset@example.test', 'reset-token');
    await service.sendSignInReminder('signin@example.test');
    await service.sendPasswordChanged('changed@example.test');

    expect(queue.add.mock.calls.map(([name]) => name as unknown)).toEqual([
      JobName.SendMail,
      JobName.SendMail,
      JobName.SendMail,
      JobName.SendMail,
    ]);
  });

  it('rejects when the queue does, so a sign-up cannot report success', async () => {
    const failure = new Error('Redis unavailable');
    queue.add.mockRejectedValueOnce(failure);

    await expect(
      service.sendVerificationLink('verify@example.test', 'verify-token'),
    ).rejects.toBe(failure);
  });
});
