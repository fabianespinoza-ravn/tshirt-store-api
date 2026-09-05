/**
 * What travels to the worker when the API decides an email should be sent.
 *
 * The shape anticipates block 7 rather than the messages that exist today:
 * the stock notification the brief marks (MUST) has to carry the product's
 * image, so a payload built for plain text alone would have to be rebuilt
 * then. `attachments` and an HTML body cost nothing now.
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
  OrderConfirmation = 'order-confirmation',
}

export interface MailAttachment {
  filename: string;
  /** Base64, because a job payload is JSON and a Buffer does not survive it. */
  content: string;
  contentType: string;
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
  /**
   * The order a confirmation is about, present only for that kind.
   *
   * An id and nothing else, which is the whole of what settlement puts in
   * here. The buyer's name, their address and their lines are all on the
   * order the id names, and none of them has any reason to sit in Redis
   * waiting for a worker. A Stripe identifier has less reason still: the
   * customer never sees one, and this payload is not the audit trail —
   * `webhook_events` and `payments` are.
   */
  orderId?: string;
  attachments?: MailAttachment[];
}
