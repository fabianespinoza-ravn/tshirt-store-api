import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { renderMail } from '../../mail/mail.content';
import { MailKind, type MailJobData } from '../../mail/mail.jobs';
import type { MailTransport } from '../../mail/mail.transport';
import { JobName } from '../queue.constants';
import { MailProcessor } from './mail.processor';

/**
 * One case here guards something no other test can.
 *
 * `MAIL_JOB_OPTIONS` discards a failed job outright, because its payload
 * holds a one-time token the database deliberately keeps only the hash of.
 * That leaves `onFailed`'s log line as the entire diagnosis — and as the
 * one remaining place the token could escape to. **Assert that the line
 * carries the kind, the recipient and the error, and that the token appears
 * nowhere in it.** A future change logging `job.data` "for debugging" would
 * put a live credential in the log aggregator, and nothing else in this
 * repository would notice.
 *
 * The unknown-job case matters for the same reason it does on the
 * maintenance queue: returning quietly on a name it does not recognise is
 * how a renamed job stops running while the queue reports itself healthy.
 */
describe('MailProcessor', () => {
  const transport = { send: jest.fn() };
  const processor = new MailProcessor(transport as unknown as MailTransport);

  const aJob = (
    name: string,
    data: Partial<MailJobData> = {},
    attemptsMade = 3,
  ): Job<MailJobData> =>
    ({
      name,
      attemptsMade,
      data: {
        kind: MailKind.Verification,
        to: 'someone@example.test',
        ...data,
      },
    }) as Job<MailJobData>;

  beforeEach(() => jest.clearAllMocks());

  describe('sending', () => {
    it('renders the job and hands the message to the transport', async () => {
      const job = aJob(JobName.SendMail, { token: 'verification-token' });
      transport.send.mockResolvedValue(undefined);

      await processor.process(job);

      expect(transport.send).toHaveBeenCalledWith(renderMail(job.data));
    });

    it('carries the recipient from the job through to the message', async () => {
      const job = aJob(JobName.SendMail, { to: 'recipient@example.test' });
      transport.send.mockResolvedValue(undefined);

      await processor.process(job);

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'recipient@example.test' }),
      );
    });

    it('throws on a job name it does not recognise, rather than ignoring it', async () => {
      await expect(processor.process(aJob('unknown-mail-job'))).rejects.toThrow(
        'Unknown mail job: unknown-mail-job',
      );
      expect(transport.send).not.toHaveBeenCalled();
    });
  });

  describe('the failure log, which is the only diagnosis left', () => {
    it('names the kind, the recipient and the error', () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const job = aJob(JobName.SendMail, { to: 'failed@example.test' }, 2);

      processor.onFailed(job, new Error('SMTP refused'));

      expect(log).toHaveBeenCalledWith(
        'verification to failed@example.test failed after 2 attempt(s): SMTP refused',
      );
      log.mockRestore();
    });

    it('says how many attempts had been made', () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const job = aJob(JobName.SendMail, {}, 7);

      processor.onFailed(job, new Error('timeout'));

      expect(log.mock.calls[0]?.[0]).toContain('after 7 attempt(s)');
      log.mockRestore();
    });

    it('never writes the token, which the discarded job took with it', () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const token = 'live-secret-token';
      const job = aJob(JobName.SendMail, { token });

      processor.onFailed(job, new Error('SMTP refused'));

      expect(String(log.mock.calls[0]?.[0])).not.toContain(token);
      log.mockRestore();
    });
  });
});
