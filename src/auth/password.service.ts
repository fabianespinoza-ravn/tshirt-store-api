import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// Argon2id con los valores por defecto de la librería (los que recomienda OWASP); no se guardan parámetros aparte porque el propio hash lleva su variante, versión y coste, así que subirlos luego no invalida los hashes ya escritos.
@Injectable()
export class PasswordService {
  // Hash con el que comparar cuando el usuario no existe: sin esto, una cuenta inexistente respondería antes que una real y el tiempo delataría cuáles están registradas.
  private readonly decoy = hash('contraseña-que-no-es-de-nadie');

  async hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch {
      // Un hash corrupto o de otro algoritmo no es una excepción del dominio:
      // es una credencial que no vale.
      return false;
    }
  }

  // Consume el mismo tiempo que una verificación real, contra el hash señuelo, para no delatar por temporización que el usuario no existe.
  async burnTime(plain: string): Promise<false> {
    await this.verify(await this.decoy, plain);
    return false;
  }
}
