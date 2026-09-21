import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/** Глобальный: письма могут понадобиться из любого модуля. */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
