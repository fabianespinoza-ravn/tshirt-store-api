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
 * The line the order number is delivered on.
 *
 * A constant for the reason `TOKEN_LINE_PREFIX` is one: it is the part of
 * the message a reader — a person or a test — goes looking for, and
 * defining it once stops the wording and whatever parses it from drifting
 * apart.
 */
export const ORDER_LINE_PREFIX = 'Order number: ';

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
     * Sent once settlement has moved an order to PAID, so what it asserts is
     * that the money arrived — not that a checkout was started, which is
     * what the client already saw in the response to their own request.
     *
     * The order number is the whole of what it carries, and that is a
     * decision rather than an omission. It is the one thing a customer
     * quotes back, to support or to `GET /orders/{id}`, and everything else
     * about the purchase is on the order it names, behind their own
     * session, correct at the moment they look. A total would have to
     * travel as cents plus a currency and be turned into a decimal here,
     * which is the one thing money in this codebase never does — and a
     * stale copy of an amount sitting in an inbox is worse than no copy.
     * Nothing from Stripe appears either: a customer has no use for an
     * intent id, and this body is not where the payment audit trail lives.
     */
    case MailKind.OrderConfirmation:
      return {
        ...base,
        subject: 'Your T-Shirt Store order is confirmed',
        text: [
          'Thank you. Your payment went through and your order is confirmed.',
          '',
          `${ORDER_LINE_PREFIX}${data.orderId ?? ''}`,
          '',
          'Sign in to see what you ordered and where it is going.',
        ].join('\n'),
      };
  }
}
