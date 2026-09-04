import { renderMail, TOKEN_LINE_PREFIX } from './mail.content';
import { MailKind, type MailJobData } from './mail.jobs';

/**
 * Two properties here are worth more than the wording of any message.
 *
 * **The token has to be in the body, on the line the suite parses.** The
 * end-to-end tests read it back out of the rendered message the way a
 * person reads it out of an inbox, so a change that stopped putting it
 * there would break account verification for real clients and would
 * deserve to break the suite too. Assert against `TOKEN_LINE_PREFIX`
 * rather than repeating the string, or the constant stops being the single
 * place it is defined.
 *
 * **And it must not be in the two messages that carry none.** The sign-in
 * reminder in particular: it goes to an address that already has an
 * account, and its whole purpose is to let sign-up answer identically
 * whether or not the address is registered. A token in it would be a
 * credential mailed to somebody who did not ask for one.
 */
describe('renderMail', () => {
  const data = (overrides: Partial<MailJobData> = {}): MailJobData => ({
    kind: MailKind.Verification,
    to: 'someone@example.test',
    ...overrides,
  });

  describe('the messages that carry a token', () => {
    it.todo('puts the verification token on the line the suite parses');
    it.todo('puts the password-reset token on that same line');
    it.todo('addresses each of them to the recipient in the job');
    it.todo('gives each a subject that says which message it is');
  });

  describe('the messages that carry none', () => {
    it.todo('sends the sign-in reminder with no token anywhere in the body');
    it.todo(
      'sends the password-changed notice with no token anywhere in the body',
    );
    it.todo(
      'tells the recipient of a password change what to do if it was not them',
    );
  });

  describe('attachments', () => {
    it.todo(
      "passes an attachment through untouched, for block 7's product image",
    );
    it.todo('leaves attachments undefined when the job carries none');
  });

  void renderMail;
  void data;
  void TOKEN_LINE_PREFIX;
});
