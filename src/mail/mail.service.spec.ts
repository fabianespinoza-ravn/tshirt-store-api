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
  // Typed, because one case reads the enqueued payload back out of
  // `mock.calls` to prove the confirmation carries no token, and an untyped
  // double makes that read an `any`.
  const queue = { add: jest.fn<Promise<unknown>, [string, MailJobData]>() };
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

  /**
   * The order confirmation, which is the first payload here that carries
   * something other than a token.
   *
   * What is worth asserting is the same negative as above, pointed the
   * other way: the job must carry `orderId` and **no `token` field at all**
   * — this message goes out on a settled purchase and there is no
   * credential anywhere near it — and it must still be named
   * `JobName.SendMail`, or it waits in the queue forever without anything
   * reporting a problem.
   *
   * Left as stubs deliberately: the method they describe was written by the
   * assistant, and an assistant-written assertion would only restate it.
   */
  it('enqueues the order confirmation with the order id and no token', async () => {
    await service.sendOrderConfirmation(
      'buyer@example.test',
      'order-confirmation-123',
    );

    expect(queue.add).toHaveBeenCalledWith(JobName.SendMail, {
      kind: MailKind.OrderConfirmation,
      to: 'buyer@example.test',
      orderId: 'order-confirmation-123',
    });
    expect(queue.add.mock.calls[0]?.[1]).not.toHaveProperty('token');
  });
  it('names the confirmation job the one the mail processor answers to, like the rest', async () => {
    await service.sendOrderConfirmation('buyer@example.test', 'order-1');

    expect(queue.add).toHaveBeenCalledWith(
      JobName.SendMail,
      expect.objectContaining({ kind: MailKind.OrderConfirmation }),
    );
  });
  it('rejects when the queue does, leaving the caller to decide what that costs', async () => {
    const failure = new Error('Redis unavailable');
    queue.add.mockRejectedValueOnce(failure);

    await expect(
      service.sendOrderConfirmation('buyer@example.test', 'order-1'),
    ).rejects.toBe(failure);
  });

  it('rejects when the queue does, so a sign-up cannot report success', async () => {
    const failure = new Error('Redis unavailable');
    queue.add.mockRejectedValueOnce(failure);

    await expect(
      service.sendVerificationLink('verify@example.test', 'verify-token'),
    ).rejects.toBe(failure);
  });
});
