import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimited } from '../common/decorators/rate-limited.decorator';
import { parseDuration } from '../common/ids';
import { NodeEnv } from '../config/env.validation';
import { AuthService, type SessionResult } from './auth.service';
import {
  ChangePasswordDto,
  ConfirmVerificationDto,
  EmailOnlyDto,
  ResetPasswordDto,
  SessionDto,
  SignInDto,
  SignUpDto,
  VerificationPendingDto,
} from './dto/auth.dto';

/** El refresh token vive sólo bajo las rutas que lo consumen. */
const REFRESH_COOKIE = 'refreshToken';
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @RateLimited(5, 60_000)
  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body() dto: SignUpDto): Promise<VerificationPendingDto> {
    await this.auth.signUp(dto.email, dto.password);
    // Idéntico exista o no la cuenta: la respuesta no puede distinguirlas.
    return { email: dto.email, verificationRequired: true };
  }

  @Public()
  @RateLimited(10, 60_000)
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  async signIn(
    @Body() dto: SignInDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const session = await this.auth.signIn(dto.email, dto.password);
    return this.respondWithSession(session, response);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    // `@Public()` porque no lleva cabecera Authorization, que no es lo mismo que
    // ser pública: la credencial es la cookie y el servicio la exige.
    const session = await this.auth.refresh(this.refreshCookie(request));
    return this.respondWithSession(session, response);
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.signOut(this.refreshCookie(request));
    response.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  @Public()
  @RateLimited(5, 60_000)
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Body() dto: EmailOnlyDto): Promise<void> {
    await this.auth.forgotPassword(dto.email);
  }

  @Public()
  @RateLimited(5, 60_000)
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @Public()
  @RateLimited(5, 60_000)
  @Post('email-verifications')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(@Body() dto: EmailOnlyDto): Promise<void> {
    await this.auth.resendEmailVerification(dto.email);
  }

  @Public()
  @Post('email-verifications/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmVerification(
    @Body() dto: ConfirmVerificationDto,
  ): Promise<void> {
    await this.auth.confirmEmailVerification(dto.token);
  }

  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  private refreshCookie(request: Request): string | undefined {
    return (request.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
  }

  private respondWithSession(
    session: SessionResult,
    response: Response,
  ): SessionDto {
    response.cookie(REFRESH_COOKIE, session.refresh.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<string>('NODE_ENV') === NodeEnv.Production,
      path: COOKIE_PATH,
      maxAge: parseDuration(this.config.get<string>('JWT_REFRESH_TTL', '7d')),
    });

    return {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      user: {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      },
    };
  }
}
