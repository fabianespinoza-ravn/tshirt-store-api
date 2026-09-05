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
    it('puts the verification token on the line the suite parses', () => {
      const token = 'verification-token';

      expect(renderMail(data({ token })).text).toContain(
        `${TOKEN_LINE_PREFIX}${token}`,
      );
    });

    it('puts the password-reset token on that same line', () => {
      const token = 'reset-token';

      expect(
        renderMail(data({ kind: MailKind.PasswordReset, token })).text,
      ).toContain(`${TOKEN_LINE_PREFIX}${token}`);
    });

    it('addresses each of them to the recipient in the job', () => {
      expect(renderMail(data({ to: 'verification@example.test' })).to).toBe(
        'verification@example.test',
      );
      expect(
        renderMail(
          data({ kind: MailKind.PasswordReset, to: 'reset@example.test' }),
        ).to,
      ).toBe('reset@example.test');
    });

    it('gives each a subject that says which message it is', () => {
      const subjects = [
        MailKind.Verification,
        MailKind.PasswordReset,
        MailKind.SignInReminder,
        MailKind.PasswordChanged,
      ].map((kind) => renderMail(data({ kind, token: 'token' })).subject);

      expect(new Set(subjects).size).toBe(4);
    });
  });

  describe('the messages that carry none', () => {
    it('sends the sign-in reminder with no token anywhere in the body', () => {
      const message = renderMail(
        data({ kind: MailKind.SignInReminder, token: 'must-not-leak' }),
      );

      expect(message.text).not.toContain(TOKEN_LINE_PREFIX);
    });

    it('sends the password-changed notice with no token anywhere in the body', () => {
      const message = renderMail(
        data({ kind: MailKind.PasswordChanged, token: 'must-not-leak' }),
      );

      expect(message.text).not.toContain(TOKEN_LINE_PREFIX);
    });

    it('tells the recipient of a password change what to do if it was not them', () => {
      expect(renderMail(data({ kind: MailKind.PasswordChanged })).text).toMatch(
        /not you/i,
      );
    });
  });

  /**
   * The order confirmation. Three properties, and the third is the one that
   * would go unnoticed.
   *
   * **The order number has to be on the line `ORDER_LINE_PREFIX` names**,
   * for the reason the token is on its own: it is the part a reader goes
   * looking for, and asserting against the constant rather than repeating
   * the string keeps the wording defined in one place.
   *
   * **No token, ever.** This message is not a credential and nothing mints
   * one for it, so `TOKEN_LINE_PREFIX` must not appear even when a job
   * carrying a stray `token` is rendered — the same check the sign-in
   * reminder and the password-changed notice already carry.
   *
   * **And its subject has to differ from the other four.** The subject test
   * above enumerates the kinds it covers, so a fifth kind is not covered by
   * it until somebody adds it; two messages that arrive under the same
   * subject line are two messages a customer reads as one.
   *
   * Stubs, not assertions: the branch they describe was written by the
   * assistant.
   */
  describe('the order confirmation', () => {
    it.todo(
      'puts the order number on the line ORDER_LINE_PREFIX names, so a reader can find it',
    );
    it.todo('renders no token line even when the job carries a stray token');
    it.todo(
      'gives it a subject distinct from the four account messages, extending the subject check to five kinds',
    );
    it.todo('addresses it to the recipient in the job');
  });

  describe('attachments', () => {
    it("passes an attachment through untouched, for block 7's product image", () => {
      const attachments = [
        {
          filename: 'product.png',
          content: 'aGVsbG8=',
          contentType: 'image/png',
        },
      ];

      expect(renderMail(data({ attachments })).attachments).toBe(attachments);
    });

    it('leaves attachments undefined when the job carries none', () => {
      expect(renderMail(data()).attachments).toBeUndefined();
    });
  });
});
