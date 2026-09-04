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
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimited } from '../common/decorators/rate-limited.decorator';
import { parseDuration } from '../common/ids';
import { Problems } from '../common/problem/problem.catalog';
import { ApiProblems } from '../common/swagger';
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

/** The refresh token only lives under the routes that consume it. */
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
  @ApiOperation({
    summary: 'Register an account and send its verification email',
    description:
      'The response is the same whether or not the address already has an account: telling them apart would disclose who is registered.',
  })
  @ApiResponse({
    status: 201,
    description: 'Verification pending',
    type: VerificationPendingDto,
  })
  @ApiProblems(
    Problems.validation,
    Problems.rateLimited,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body() dto: SignUpDto): Promise<VerificationPendingDto> {
    await this.auth.signUp(dto.email, dto.password);
    // Identical whether or not the account exists: the response can't tell
    // the two cases apart.
    return { email: dto.email, verificationRequired: true };
  }

  @Public()
  @RateLimited(10, 60_000)
  @ApiOperation({
    summary: 'Exchange credentials for an access token and a refresh cookie',
  })
  @ApiResponse({
    status: 200,
    description: 'Session started',
    type: SessionDto,
  })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.emailNotVerified,
    Problems.rateLimited,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
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
  @ApiCookieAuth('cookieAuth')
  @ApiOperation({
    summary: 'Rotate the session from the refresh cookie',
    description:
      'The credential is the cookie, not the Authorization header, which is why the route carries no bearer requirement.',
  })
  @ApiResponse({
    status: 200,
    description: 'Session rotated',
    type: SessionDto,
  })
  @ApiProblems(
    Problems.unauthorized,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    // `@Public()` because it carries no Authorization header, which isn't the
    // same as being public: the credential is the cookie, and the service
    // requires it.
    const session = await this.auth.refresh(this.refreshCookie(request));
    return this.respondWithSession(session, response);
  }

  // One single requirement with both schemes, not two requirements:
  // separated, the security array reads as "bearer OR cookie", and here the
  // matrix requires both at once.
  @ApiSecurity({ bearerAuth: [], cookieAuth: [] })
  @ApiOperation({ summary: 'Revoke the refresh token and clear its cookie' })
  @ApiResponse({ status: 204, description: 'Session ended' })
  @ApiProblems(
    Problems.unauthorized,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
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
  @ApiOperation({
    summary: 'Send a password reset link',
    description: 'Accepted whether or not the address exists.',
  })
  @ApiResponse({
    status: 202,
    description: 'Reset link sent if the address exists',
  })
  @ApiProblems(
    Problems.validation,
    Problems.rateLimited,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Body() dto: EmailOnlyDto): Promise<void> {
    await this.auth.forgotPassword(dto.email);
  }

  @Public()
  @RateLimited(5, 60_000)
  @ApiOperation({ summary: 'Set a new password from a reset token' })
  @ApiResponse({ status: 204, description: 'Password changed' })
  @ApiProblems(
    Problems.validation,
    Problems.notFound,
    Problems.rateLimited,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @Public()
  @RateLimited(5, 60_000)
  @ApiOperation({ summary: 'Resend the verification email' })
  @ApiResponse({
    status: 202,
    description: 'Verification email sent if the address needs one',
  })
  @ApiProblems(
    Problems.validation,
    Problems.rateLimited,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('email-verifications')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(@Body() dto: EmailOnlyDto): Promise<void> {
    await this.auth.resendEmailVerification(dto.email);
  }

  @Public()
  @ApiOperation({
    summary: 'Confirm an email address from its verification token',
  })
  @ApiResponse({ status: 204, description: 'Address verified' })
  @ApiProblems(
    Problems.validation,
    Problems.emailVerificationTokenNotFound,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('email-verifications/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmVerification(
    @Body() dto: ConfirmVerificationDto,
  ): Promise<void> {
    await this.auth.confirmEmailVerification(dto.token);
  }

  @ApiBearerAuth('bearerAuth')
  @ApiOperation({
    summary: 'Change the password of the authenticated account',
    description: 'The account is notified by email.',
  })
  @ApiResponse({ status: 204, description: 'Password changed' })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
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
