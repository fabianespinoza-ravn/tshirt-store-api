// Los demás specs lo arrastran a través de `@nestjs/testing`. Éste no monta
// ningún módulo de Nest, y sin los metadatos de diseño class-transformer no
// puede leer los tipos: `Reflect.getMetadata is not a function`.
import 'reflect-metadata';

import { NodeEnv, validateEnv } from './env.validation';

/**
 * El entorno mínimo con el que la aplicación arranca: sólo las variables que
 * no tienen valor por defecto. Cada test parte de aquí y rompe una sola cosa,
 * para que lo que falle sea siempre lo que el test dice que rompe.
 */
function anEnv(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/store?schema=public',
    REDIS_HOST: 'localhost',
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_SECRET: 'refresh-secret',
    JWT_REFRESH_TTL: '7d',
    AWS_REGION: 'us-east-1',
    AWS_S3_BUCKET: 'tshirt-store-images',
    AWS_ACCESS_KEY_ID: 'access-key',
    AWS_SECRET_ACCESS_KEY: 'secret-key',
    ...overrides,
  };
}

/** El mismo entorno al que le faltan las variables que se le nombren. */
function anEnvWithout(...missing: string[]): Record<string, unknown> {
  const env: Record<string, unknown> = anEnv();
  for (const key of missing) delete env[key];
  return env;
}

describe('validateEnv', () => {
  it('applies the declared defaults when only the required variables are set', () => {
    const env = validateEnv(anEnv());

    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(3000);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.THROTTLE_TTL).toBe(60_000);
    expect(env.THROTTLE_LIMIT).toBe(10);
  });

  /**
   * El entorno sólo entrega cadenas. La conversión implícita es la que hace
   * que `@IsInt()` vea un número, y es justo lo que la cabecera del módulo
   * advierte que se rompe si a una propiedad numérica le falta su anotación
   * de tipo. Fijarlo aquí es lo que avisa si alguien la quita.
   */
  it('converts the numeric variables the environment hands over as strings', () => {
    const env = validateEnv(anEnv({ PORT: '3010', THROTTLE_LIMIT: '25' }));

    expect(env.PORT).toBe(3010);
    expect(env.THROTTLE_LIMIT).toBe(25);
  });

  /**
   * El valor de arrancar validando el entorno está entero en este caso: si el
   * mensaje no dice cuál falta, el proceso muere igual pero nadie sabe por
   * qué. Se comprueba que nombra la variable, no el texto completo, que es
   * detalle de class-validator y no contrato de este módulo.
   */
  it('names the missing variable instead of failing anonymously', () => {
    expect(() => validateEnv(anEnvWithout('DATABASE_URL'))).toThrow(
      /DATABASE_URL/,
    );
  });

  it('reports every offending variable at once, not just the first', () => {
    const incomplete = anEnvWithout('JWT_ACCESS_SECRET', 'AWS_S3_BUCKET');

    expect(() => validateEnv(incomplete)).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => validateEnv(incomplete)).toThrow(/AWS_S3_BUCKET/);
  });
});
