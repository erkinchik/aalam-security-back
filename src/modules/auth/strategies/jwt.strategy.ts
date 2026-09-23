import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

interface JwtPayload {
  sub: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.accessSecret'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, deletedAt: true },
    });

    // Удалённая учётка теряет доступ сразу, а не когда истечёт access-токен:
    // иначе удалённый оператор ещё 15 минут мог заступить на смену и получать
    // карточки вызовов с данными заявителей.
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }

    return { id: user.id, email: user.email, role: user.role };
  }
}
