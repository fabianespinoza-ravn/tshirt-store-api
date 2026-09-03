import { Injectable, Logger } from '@nestjs/common';

// No real SMTP transport yet (optional variables for Week 3): it logs, and
// the plaintext token is only printed outside production so it can be
// tested.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  // Verification link: used both for a new account and for a resend.
  sendVerificationLink(email: string, token: string): Promise<void> {
    this.devOnly('email verification', email, token);
    return Promise.resolve();
  }

  // Notice to an already-verified account trying to sign up again: it lets
  // sign-up always respond the same way, leaving the email, not the
  // response, to tell the cases apart.
  sendSignInReminder(email: string): Promise<void> {
    this.logger.log(`[mail] sign-in reminder -> ${email}`);
    return Promise.resolve();
  }

  sendPasswordReset(email: string, token: string): Promise<void> {
    this.devOnly('password reset', email, token);
    return Promise.resolve();
  }

  // Notification the brief requires after a password change, even though
  // the code doesn't give that away.
  sendPasswordChanged(email: string): Promise<void> {
    this.logger.log(`[mail] password changed -> ${email}`);
    return Promise.resolve();
  }

  private devOnly(subject: string, email: string, token: string): void {
    if (process.env.NODE_ENV === 'production') {
      this.logger.log(`[mail] ${subject} -> ${email}`);
      return;
    }
    this.logger.warn(
      `[mail] ${subject} -> ${email} | token=${token} (outside production only)`,
    );
  }
}
