import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JobName, QueueName } from '../queue/queue.constants';
import { MailKind, type MailJobData } from './mail.jobs';

/**
 * A producer, since block 4. It decides that a message should be sent and
 * stops there; the worker decides what it says and delivers it.
 *
 * The account methods kept the signatures they had in the version that
 * logged, so `AuthService` did not have to know that any of this happened —
 * which is the shape the architecture write-up describes and the reason
 * that change was confined to this file.
 *
 * What did change is when the caller's promise resolves. It used to mean
 * "the message was handled"; it now means "the job was accepted". A sign-up
 * that returns 201 is promising that an email will be sent, not that it has
 * been — and if Redis is unreachable, `add` rejects and the sign-up fails
 * rather than silently swallowing the account's only way to be verified.
 *
 * **Every method here rejects, and every caller decides what that means.**
 * `AuthService.notify` swallows a rejection because three of its endpoints
 * must answer the same way for an address that exists and one that does
 * not. `SettlementService` swallows it for a different and stronger reason
 * — by the time it calls, money has moved and an order is PAID — and
 * `signUp` deliberately does not swallow at all. This class does not
 * choose for them.
 */
@Injectable()
export class MailService {
  constructor(
    @InjectQueue(QueueName.Mail) private readonly queue: Queue<MailJobData>,
  ) {}

  sendVerificationLink(email: string, token: string): Promise<void> {
    return this.enqueue({ kind: MailKind.Verification, to: email, token });
  }

  sendSignInReminder(email: string): Promise<void> {
    return this.enqueue({ kind: MailKind.SignInReminder, to: email });
  }

  sendPasswordReset(email: string, token: string): Promise<void> {
    return this.enqueue({ kind: MailKind.PasswordReset, to: email, token });
  }

  sendPasswordChanged(email: string): Promise<void> {
    return this.enqueue({ kind: MailKind.PasswordChanged, to: email });
  }

  /**
   * The only message here that is not about an account.
   *
   * It takes the order's id rather than the order, because that is all the
   * body says and all the payload is allowed to hold — see `MailJobData`.
   * Passing the row would put the buyer's name and postal address into a
   * queue that has no use for either.
   */
  sendOrderConfirmation(email: string, orderId: string): Promise<void> {
    return this.enqueue({
      kind: MailKind.OrderConfirmation,
      to: email,
      orderId,
    });
  }

  /**
   * No `jobId`, deliberately, where the rest of block 4 uses one for
   * idempotency. Two verification emails to the same address are two
   * different messages carrying two different tokens — a resend is a
   * feature of the contract, not a duplicate to be collapsed. The
   * idempotency that matters in this block belongs to settlement, where
   * repeating the job would move money twice.
   */
  private async enqueue(data: MailJobData): Promise<void> {
    await this.queue.add(JobName.SendMail, data);
  }
}
