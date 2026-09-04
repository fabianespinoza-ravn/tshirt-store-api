import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
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
    it.todo('renders the job and hands the message to the transport');
    it.todo('carries the recipient from the job through to the message');
    it.todo(
      'throws on a job name it does not recognise, rather than ignoring it',
    );
  });

  describe('the failure log, which is the only diagnosis left', () => {
    it.todo('names the kind, the recipient and the error');
    it.todo('says how many attempts had been made');
    it.todo('never writes the token, which the discarded job took with it');
  });

  void transport;
  void processor;
  void aJob;
  void JobName;
  void Logger;
});
