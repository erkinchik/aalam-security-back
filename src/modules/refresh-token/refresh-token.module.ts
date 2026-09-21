import { Global, Module } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';

/** Глобальный: сессии отзывают и auth, и users, и admin. */
@Global()
@Module({
  providers: [RefreshTokenService],
  exports: [RefreshTokenService],
})
export class RefreshTokenModule {}
