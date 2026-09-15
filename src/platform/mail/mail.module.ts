import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * The producer only. The transport and the processor that uses it live in
 * the worker's module tree, so importing this module cannot accidentally
 * turn the API into a mail sender.
 *
 * The queue itself comes from `QueueModule`, which is global.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
