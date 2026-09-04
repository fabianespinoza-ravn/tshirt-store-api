import type { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { MailTransport } from './mail.transport';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

/**
 * The thinnest file in the module, and it still has one property worth
 * pinning: **the log line must not carry the body.**
 *
 * A verification message's text holds the one-time token — that is the
 * whole point of it — and the queue keeps nothing on either outcome, so a
 * log line is the only artefact of a send that survives. Logging the
 * message rather than its subject would put a live credential in the log
 * aggregator, which is exactly the exposure the retention policy was
 * changed to avoid.
 *
 * The rest is configuration, and the case that earns its place is
 * `secure`: it has to follow the port, because 465 speaks TLS from the
 * first byte and 587 negotiates it. Getting that backwards fails at
 * connect time in production and nowhere earlier.
 */
describe('MailTransport', () => {
  const sendMail = jest.fn();
  const config = {
    getOrThrow: jest.fn(),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    (createTransport as jest.Mock).mockReturnValue({ sendMail });
  });

  it.todo('reads host, port and credentials from configuration');
  it.todo('asks for an implicit TLS connection on 465 and negotiates on 587');
  it.todo('sends with the configured From, not one taken from the message');
  it.todo('decodes an attachment back from base64 before handing it over');
  it.todo('logs the subject and the recipient after a send');
  it.todo(
    'never writes the message body to the log, because it holds the token',
  );

  void config;
  void MailTransport;
  void sendMail;
});
