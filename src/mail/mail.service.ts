import { Injectable, Logger } from '@nestjs/common';

// Sin transporte SMTP real aún (variables opcionales para la Semana 3): se loguea, y el token en claro sólo se imprime fuera de producción para poder probar.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  // Enlace de verificación: se usa tanto para una cuenta nueva como para un reenvío.
  sendVerificationLink(email: string, token: string): Promise<void> {
    this.devOnly('verificación de correo', email, token);
    return Promise.resolve();
  }

  // Aviso a una cuenta ya verificada que intenta registrarse otra vez: permite que sign-up responda siempre igual y sea el correo, no la respuesta, quien distinga los casos.
  sendSignInReminder(email: string): Promise<void> {
    this.logger.log(`[correo] recordatorio de inicio de sesión -> ${email}`);
    return Promise.resolve();
  }

  sendPasswordReset(email: string, token: string): Promise<void> {
    this.devOnly('restablecimiento de contraseña', email, token);
    return Promise.resolve();
  }

  // Notificación exigida por el programa tras un cambio de contraseña, aunque el código no lo delate.
  sendPasswordChanged(email: string): Promise<void> {
    this.logger.log(`[correo] contraseña cambiada -> ${email}`);
    return Promise.resolve();
  }

  private devOnly(asunto: string, email: string, token: string): void {
    if (process.env.NODE_ENV === 'production') {
      this.logger.log(`[correo] ${asunto} -> ${email}`);
      return;
    }
    this.logger.warn(
      `[correo] ${asunto} -> ${email} | token=${token} (sólo fuera de producción)`,
    );
  }
}
