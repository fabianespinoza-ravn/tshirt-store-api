import { IsEmail, IsString, MinLength } from 'class-validator';

// The minimum is enforced at sign-up, reset and change, but not at sign-in:
// announcing the minimum length there would hand anyone testing credentials
// a free cut to their search space.
const MIN_PASSWORD = 12;

export class SignUpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(MIN_PASSWORD)
  password!: string;
}

export class SignInDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class EmailOnlyDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(MIN_PASSWORD)
  newPassword!: string;
}

export class ConfirmVerificationDto {
  @IsString()
  @MinLength(1)
  token!: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(MIN_PASSWORD)
  newPassword!: string;
}

// Sign-up response, identical whether or not the account exists, so the
// route can't be used to enumerate addresses.
export class VerificationPendingDto {
  email!: string;
  verificationRequired!: boolean;
}

export class SessionUserDto {
  id!: string;
  email!: string;
  role!: string;
}

export class SessionDto {
  accessToken!: string;
  tokenType!: 'Bearer';
  user!: SessionUserDto;
}
