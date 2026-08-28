import { IsEmail, IsString, MinLength } from 'class-validator';

// El mínimo se exige en registro, restablecimiento y cambio, pero no en el inicio de sesión: anunciar ahí la longitud mínima le recortaría gratis el espacio de búsqueda a quien prueba credenciales.
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

// Respuesta de sign-up, idéntica exista o no la cuenta, para que la ruta no sirva para enumerar direcciones.
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
