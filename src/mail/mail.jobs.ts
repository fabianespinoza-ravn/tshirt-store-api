import type { Color, Size } from '@prisma/client';

/**
 * What travels to the worker when the API decides an email should be sent.
 *
 * The shape anticipates block 7 rather than the four messages that exist
 * today: the stock notification the brief marks (MUST) has to carry the
 * product's image, so a payload built for plain text alone would have to be
 * rebuilt then. `attachments` and an HTML body cost nothing now.
 *
 * What it must never grow is anything else secret. `token` is already the
 * uncomfortable part — see MAIL_JOB_OPTIONS for why this queue keeps
 * neither completed nor failed jobs.
 */
export enum MailKind {
  Verification = 'verification',
  SignInReminder = 'sign-in-reminder',
  PasswordReset = 'password-reset',
  PasswordChanged = 'password-changed',
  LowStock = 'low-stock',
}

export interface MailAttachment {
  filename: string;
  /** Base64, because a job payload is JSON and a Buffer does not survive it. */
  content: string;
  contentType: string;
}

/**
 * What the low-stock message needs in order to say something useful, and
 * nothing beyond it.
 *
 * The variant is named because the crossing is per SKU: "your size is nearly
 * gone" is actionable in a way that "this product is nearly gone" is not,
 * and the reader can already see the picture. `remaining` is a count of
 * units, never money, so no rounding question arises.
 */
export interface LowStockDetails {
  productName: string;
  size: Size;
  color: Color;
  /** Units a shopper could still buy: stock less what is already reserved. */
  remaining: number;
}

export interface MailJobData {
  kind: MailKind;
  to: string;
  /**
   * The one-time token, present only for the two kinds that carry one.
   *
   * The database stores its hash, so this is the only place the usable
   * value exists between the request that minted it and the message that
   * delivers it. That is why the queue discards the job either way.
   */
  token?: string;
  /** Present only on `MailKind.LowStock`. */
  lowStock?: LowStockDetails;
  attachments?: MailAttachment[];
}
