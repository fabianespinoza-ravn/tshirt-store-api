// Every other spec pulls this in through `@nestjs/testing`. This one mounts
// no Nest module at all, and without the design metadata class-transformer
// can't read the types: `Reflect.getMetadata is not a function`.
import 'reflect-metadata';

import { NodeEnv, validateEnv } from './env.validation';

/**
 * The minimal environment the application boots with: only the variables
 * that have no default value. Every test starts from here and breaks a
 * single thing, so whatever fails is always what the test says it breaks.
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
    SMTP_HOST: 'smtp.example.test',
    SMTP_USER: 'mailer',
    SMTP_PASSWORD: 'mailer-password',
    MAIL_FROM: 'T-Shirt Store <store@example.test>',
    ...overrides,
  };
}

/** The same environment, missing whichever variables are named. */
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
   * The environment only ever hands over strings. Implicit conversion is
   * what makes `@IsInt()` see a number, and it's exactly what the module's
   * header warns breaks if a numeric property is missing its type
   * annotation. Pinning it here is what raises the alarm if someone removes
   * it.
   */
  it('converts the numeric variables the environment hands over as strings', () => {
    const env = validateEnv(anEnv({ PORT: '3010', THROTTLE_LIMIT: '25' }));

    expect(env.PORT).toBe(3010);
    expect(env.THROTTLE_LIMIT).toBe(25);
  });

  /**
   * The whole value of validating the environment at boot lives in this
   * case: if the message doesn't say which one is missing, the process dies
   * all the same but nobody knows why. What's checked is that it names the
   * variable, not the full text, which is class-validator's detail and not
   * this module's contract.
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
  /**
   * The mail variables became required in block 4, and the review is right
   * that nothing exercised them. The one worth writing carefully is the
   * MAIL_FROM pattern: a display name alone has to be refused, and so does a
   * value carrying a newline, because that string reaches the `From` header
   * verbatim and a newline there starts a header somebody else chose.
   */
  it('refuses an environment with no SMTP host, user or password', () => {
    expect(() =>
      validateEnv(anEnvWithout('SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD')),
    ).toThrow(/SMTP_HOST.*SMTP_USER.*SMTP_PASSWORD/s);
  });

  it('refuses an SMTP_PORT outside the range of a port', () => {
    expect(() => validateEnv(anEnv({ SMTP_PORT: 0 }))).toThrow(/SMTP_PORT/);
    expect(() => validateEnv(anEnv({ SMTP_PORT: 70_000 }))).toThrow(
      /SMTP_PORT/,
    );
  });

  it('defaults SMTP_PORT to 587 when it is absent', () => {
    expect(validateEnv(anEnv()).SMTP_PORT).toBe(587);
  });

  it('accepts a bare address and an address with a display name in MAIL_FROM', () => {
    expect(
      validateEnv(anEnv({ MAIL_FROM: 'store@example.test' })).MAIL_FROM,
    ).toBe('store@example.test');
    expect(
      validateEnv(anEnv({ MAIL_FROM: 'T-Shirt Store <store@example.test>' }))
        .MAIL_FROM,
    ).toBe('T-Shirt Store <store@example.test>');
  });

  it('refuses a MAIL_FROM that is only a display name', () => {
    expect(() => validateEnv(anEnv({ MAIL_FROM: 'Alford White' }))).toThrow(
      /MAIL_FROM/,
    );
  });

  it('refuses a MAIL_FROM carrying a carriage return or a newline', () => {
    expect(() =>
      validateEnv(
        anEnv({ MAIL_FROM: '\r\nBcc: victim@example.test <us@example.test>' }),
      ),
    ).toThrow(/MAIL_FROM/);
  });
});
