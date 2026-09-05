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

  /**
   * The fifth kind, and the first that renders a payload rather than a
   * token.
   *
   * Two of the cases below are about a message that must go out anyway. The
   * product image is fetched from S3 while the worker holds a job and is
   * dropped whenever that fails, so `attachments` is routinely absent — and
   * `lowStock` itself is optional on `MailJobData`, which means a renderer
   * that reached into it unguarded would turn a missing field into a job
   * that fails three times and is then discarded with its recipient. The
   * message has to survive both.
   */
  describe('the low-stock notification', () => {
    it.todo('names the product in the subject');

    it.todo('names the size and the colour of the variant that is running out');

    it.todo('says how many units are left');

    it.todo(
      'says why the recipient is hearing about it: they liked it and never ordered it',
    );

    it.todo('carries no token line, because this message has nothing to prove');

    it.todo('passes the product image through as an attachment');

    it.todo('still renders a sendable message when the image was dropped');

    it.todo(
      'still renders a sendable message when the job carries no low-stock detail at all',
    );
  });
});
