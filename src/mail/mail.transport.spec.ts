import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
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
  // Kept as its mock type and cast only where it is handed over, so the
  // helper below can still program it.
  const getOrThrow = jest.fn<unknown, [string]>();
  const config = { getOrThrow } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    (createTransport as jest.Mock).mockReturnValue({ sendMail });
  });

  function makeTransport(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: 587,
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'password',
      MAIL_FROM: 'Configured <configured@example.test>',
      ...overrides,
    };
    getOrThrow.mockImplementation((key: string) => values[key]);
    return new MailTransport(config);
  }

  it('reads host, port and credentials from configuration', () => {
    makeTransport();

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'mailer', pass: 'password' },
    });
  });

  /**
   * Opportunistic negotiation is not enough: without `requireTLS` a server
   * that does not offer STARTTLS gets the credentials and the one-time token
   * in clear text, and nothing warns. The transport asks nodemailer to
   * refuse that connection instead, which is the only place the decision can
   * be made — by the time a message is being sent it is too late.
   */
  it('requires STARTTLS on every port that is not implicit TLS', () => {
    makeTransport({ SMTP_PORT: 587 });
    makeTransport({ SMTP_PORT: 2525 });
    makeTransport({ SMTP_PORT: 465 });

    expect(createTransport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requireTLS: true }),
    );
    expect(createTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requireTLS: true }),
    );
    // 465 is already encrypted from the first byte, so demanding an upgrade
    // on it would ask for something that cannot happen.
    expect(createTransport).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ secure: true, requireTLS: false }),
    );
  });

  it('asks for an implicit TLS connection on 465 and negotiates on 587', () => {
    makeTransport({ SMTP_PORT: 465 });
    makeTransport({ SMTP_PORT: 587 });

    expect(createTransport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ port: 465, secure: true }),
    );
    expect(createTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ port: 587, secure: false }),
    );
  });

  it('sends with the configured From, not one taken from the message', async () => {
    const transport = makeTransport({ MAIL_FROM: 'configured@example.test' });
    sendMail.mockResolvedValue(undefined);

    await transport.send({
      to: 'recipient@example.test',
      subject: 'Subject',
      text: 'Body',
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'configured@example.test' }),
    );
  });

  it('decodes an attachment back from base64 before handing it over', async () => {
    const transport = makeTransport();
    sendMail.mockResolvedValue(undefined);

    await transport.send({
      to: 'recipient@example.test',
      subject: 'Subject',
      text: 'Body',
      attachments: [
        {
          filename: 'hello.txt',
          content: 'aGVsbG8=',
          contentType: 'text/plain',
        },
      ],
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            filename: 'hello.txt',
            content: Buffer.from('hello'),
            contentType: 'text/plain',
          },
        ],
      }),
    );
  });

  it('logs the subject and the recipient after a send', async () => {
    const transport = makeTransport();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    sendMail.mockResolvedValue(undefined);

    await transport.send({
      to: 'recipient@example.test',
      subject: 'Subject',
      text: 'Body',
    });

    expect(log).toHaveBeenCalledWith(
      'Sent "Subject" to recipient@example.test',
    );
    log.mockRestore();
  });

  it('never writes the message body to the log, because it holds the token', async () => {
    const transport = makeTransport();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const token = 'live-secret-token';
    sendMail.mockResolvedValue(undefined);

    await transport.send({
      to: 'recipient@example.test',
      subject: 'Subject',
      text: `Your code: ${token}`,
    });

    expect(String(log.mock.calls[0]?.[0])).not.toContain(token);
    log.mockRestore();
  });
});
