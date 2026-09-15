import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailMessage } from './mail.content';

/**
 * The seam between the worker and a real mail server.
 *
 * It exists as a class rather than as a direct nodemailer call inside the
 * processor so the end-to-end suite can replace exactly this and nothing
 * else: the queue, the job, the processor and the rendering all run for
 * real, and only the socket is stood in for. Replacing `MailService`
 * instead — which is what the suite did before there was a queue — would
 * have meant the producer, the job and the consumer never ran at all.
 */
@Injectable()
export class MailTransport {
  private readonly logger = new Logger(MailTransport.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    const port = config.getOrThrow<number>('SMTP_PORT');

    this.from = config.getOrThrow<string>('MAIL_FROM');
    this.transporter = createTransport({
      host: config.getOrThrow<string>('SMTP_HOST'),
      port,
      // Implicit TLS on 465; everything else negotiates STARTTLS — and
      // must get it. Without `requireTLS` nodemailer's negotiation is
      // opportunistic: a server that does not offer STARTTLS gets the
      // credentials and the one-time token in clear text, on a connection
      // nothing warns about.
      secure: port === 465,
      requireTLS: port !== 465,
      auth: {
        user: config.getOrThrow<string>('SMTP_USER'),
        pass: config.getOrThrow<string>('SMTP_PASSWORD'),
      },
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content, 'base64'),
        contentType: attachment.contentType,
      })),
    });

    // The recipient, never the body: a verification message has the
    // one-time token in its text, and a log line is the one place it must
    // not end up now that the queue deliberately keeps nothing.
    this.logger.log(`Sent "${message.subject}" to ${message.to}`);
  }
}
