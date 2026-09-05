import {
  TOKEN_LINE_PREFIX,
  type MailMessage,
} from '../../src/mail/mail.content';

export { MailKind } from '../../src/mail/mail.jobs';

/**
 * Stands in for `MailTransport` — the socket, and nothing above it.
 *
 * Before block 4 this replaced `MailService`, because that service was a
 * logger and there was nothing else to stand in for. Now the producer, the
 * job, the queue, the consumer and the rendering all run for real in the
 * suite, and only the send is intercepted. The difference matters: a test
 * that replaced `MailService` today would pass while the queue was
 * misconfigured, the worker never started, or the processor threw.
 *
 * Which is why the token is read back out of the **rendered message**, the
 * way a person reads it out of an inbox, rather than from the job payload.
 * If a change stops putting the token in the email, the client cannot
 * verify their account, and this suite should not be able to either.
 */
export class MailRecorder {
  readonly sent: MailMessage[] = [];

  private readonly waiting: {
    to: string;
    resolve: (message: MailMessage) => void;
  }[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);

    for (let i = this.waiting.length - 1; i >= 0; i -= 1) {
      if (this.waiting[i].to === message.to) {
        this.waiting[i].resolve(message);
        this.waiting.splice(i, 1);
      }
    }

    return Promise.resolve();
  }

  /**
   * Waits for a message to an address, and resolves immediately if one has
   * already arrived.
   *
   * A queue makes the send asynchronous, so a test that read the recorder
   * straight after the request would usually find nothing. The alternative
   * to this is a sleep, which is how a suite becomes intermittent: too
   * short and it fails under load, too long and it wastes a second per
   * test. This resolves the moment the worker delivers.
   */
  waitFor(to: string, timeoutMs = 10_000): Promise<MailMessage> {
    const already = this.lastFor(to);
    if (already) return Promise.resolve(already);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiting.findIndex((w) => w.to === to);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(
          new Error(
            `No mail reached ${to} within ${timeoutMs}ms. The worker may not be consuming.`,
          ),
        );
      }, timeoutMs);

      this.waiting.push({
        to,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  /** The most recent message to that address, if one has arrived. */
  lastFor(to: string): MailMessage | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i].to === to) return this.sent[i];
    }
    return undefined;
  }

  /**
   * The one-time token, parsed out of the message body. Returns undefined
   * for the two kinds that carry none, which is the correct answer for
   * them rather than a failure.
   */
  tokenIn(message: MailMessage): string | undefined {
    const line = message.text
      .split('\n')
      .find((candidate) => candidate.startsWith(TOKEN_LINE_PREFIX));

    return line?.slice(TOKEN_LINE_PREFIX.length).trim() || undefined;
  }

  /**
   * The token in the next message to that address, waiting for it if the
   * worker has not delivered yet. What most call sites actually want.
   */
  async tokenFor(to: string, timeoutMs?: number): Promise<string | undefined> {
    return this.tokenIn(await this.waitFor(to, timeoutMs));
  }

  reset(): void {
    this.sent.length = 0;
    this.waiting.length = 0;
  }
}
