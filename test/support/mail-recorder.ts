import type { MailService } from '../../src/mail/mail.service';

export enum MailKind {
  Verification = 'verification',
  SignInReminder = 'sign-in-reminder',
  PasswordReset = 'password-reset',
  PasswordChanged = 'password-changed',
}

export interface RecordedMail {
  kind: MailKind;
  email: string;
  token?: string;
}

/**
 * Stands in for MailService in the e2e application. Nothing real is
 * replaced — the real service has no transport and only logs — but the
 * flow needs the one-time tokens it would have sent, and this is where a
 * test reads them from.
 */
export class MailRecorder implements Pick<
  MailService,
  | 'sendVerificationLink'
  | 'sendSignInReminder'
  | 'sendPasswordReset'
  | 'sendPasswordChanged'
> {
  readonly sent: RecordedMail[] = [];

  sendVerificationLink(email: string, token: string): Promise<void> {
    this.sent.push({ kind: MailKind.Verification, email, token });
    return Promise.resolve();
  }

  sendSignInReminder(email: string): Promise<void> {
    this.sent.push({ kind: MailKind.SignInReminder, email });
    return Promise.resolve();
  }

  sendPasswordReset(email: string, token: string): Promise<void> {
    this.sent.push({ kind: MailKind.PasswordReset, email, token });
    return Promise.resolve();
  }

  sendPasswordChanged(email: string): Promise<void> {
    this.sent.push({ kind: MailKind.PasswordChanged, email });
    return Promise.resolve();
  }

  /** The most recent token of that kind sent to that address, if any. */
  lastTokenFor(email: string, kind: MailKind): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const mail = this.sent[i];
      if (mail.email === email && mail.kind === kind) return mail.token;
    }
    return undefined;
  }

  reset(): void {
    this.sent.length = 0;
  }
}
