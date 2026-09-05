import { MailKind, type MailJobData } from './mail.jobs';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: MailJobData['attachments'];
}

/**
 * The line a token is delivered on.
 *
 * It is a constant and not an inline string because the end-to-end suite
 * reads the token back out of the rendered message, exactly as a person
 * would read it out of their inbox. That makes the suite depend on the
 * wording — which is the point: if a change stops putting the token in the
 * email, the client cannot verify their account either, and a test that
 * kept passing would be lying about a broken flow.
 */
export const TOKEN_LINE_PREFIX = 'Your code: ';

/**
 * Rendering lives here, in a pure function, and not in the processor.
 *
 * Two reasons. It is the part with the most detail and the least
 * machinery, so it is worth testing without a queue or a transport
 * anywhere near it. And keeping it out of the API means a change to the
 * wording of an email cannot break a request path.
 */
export function renderMail(data: MailJobData): MailMessage {
  const base = { to: data.to, attachments: data.attachments };

  switch (data.kind) {
    case MailKind.Verification:
      return {
        ...base,
        subject: 'Confirm your T-Shirt Store account',
        text: [
          'Welcome to the T-Shirt Store.',
          '',
          `${TOKEN_LINE_PREFIX}${data.token ?? ''}`,
          '',
          'If you did not create this account, ignore this message.',
        ].join('\n'),
      };

    case MailKind.PasswordReset:
      return {
        ...base,
        subject: 'Reset your T-Shirt Store password',
        text: [
          'Somebody asked to reset the password on this account.',
          '',
          `${TOKEN_LINE_PREFIX}${data.token ?? ''}`,
          '',
          'If it was not you, this code expires on its own and nothing has changed.',
        ].join('\n'),
      };

    /**
     * Sent to an address that already has a verified account when somebody
     * tries to sign up with it again. It carries no token by design: it is
     * what lets sign-up answer identically whether or not the address is
     * registered, leaving the inbox rather than the response to tell the
     * two apart.
     */
    case MailKind.SignInReminder:
      return {
        ...base,
        subject: 'You already have a T-Shirt Store account',
        text: [
          'Somebody tried to sign up with this address, and it is already registered.',
          '',
          'If that was you, sign in instead. If it was not, no action is needed.',
        ].join('\n'),
      };

    case MailKind.PasswordChanged:
      return {
        ...base,
        subject: 'Your T-Shirt Store password changed',
        text: [
          'The password on this account was just changed.',
          '',
          'If that was not you, reset it now — whoever changed it can sign in.',
        ].join('\n'),
      };

    /**
     * The stock notification the brief marks (MUST). It goes to somebody who
     * liked a product and never bought it, so it has to read as a nudge and
     * not as a receipt — and it has to survive its details being absent,
     * because a rendering that threw would turn a missing field into a mail
     * job that fails three times and is then discarded with its recipient.
     *
     * The product's image rides in `attachments`, which `base` already
     * carries through: it is bytes rather than a link because the bucket is
     * private and a presigned URL dies long before an inbox does. See
     * `src/notifications/product-image.attachment.ts`.
     */
    case MailKind.LowStock: {
      const item = data.lowStock;
      const named = item ? item.productName : 'Something you liked';

      return {
        ...base,
        subject: `Running low: ${named}`,
        text: [
          item
            ? `${item.productName} — ${item.size}, ${item.color.toLowerCase()} — is nearly out of stock.`
            : `${named} is nearly out of stock.`,
          '',
          item ? `Only ${item.remaining} left.` : 'Only a few are left.',
          '',
          'You liked it and have not ordered it yet. The photograph is attached.',
        ].join('\n'),
      };
    }
  }
}
