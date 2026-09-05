import { Global, Module } from '@nestjs/common';
import { StockNotificationsService } from './stock-notifications.service';

/**
 * The producer only, exactly like `MailModule`.
 *
 * `StockNotificationDispatcher` and `StockNotificationProcessor` are
 * deliberately absent: they belong to `worker.module.ts`, so importing this
 * cannot turn the API into the process that fans out the emails. What is
 * exported is the one seam a write that moves stock needs — the crossing —
 * and it does nothing but enqueue.
 *
 * Global for the same reason `MailModule` is: the callers are whichever
 * services turn out to change `Sku.stock`, and threading an import through
 * each of them says nothing a reader did not already know.
 */
@Global()
@Module({
  providers: [StockNotificationsService],
  exports: [StockNotificationsService],
})
export class NotificationsModule {}
