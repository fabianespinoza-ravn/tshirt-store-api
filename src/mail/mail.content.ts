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
  }
}
