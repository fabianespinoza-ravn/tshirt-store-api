import { Test } from '@nestjs/testing';
import type { Provider, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { ProductsService } from '../catalog/products.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { createPrismaMock, type PrismaMock } from './prisma.mock';

export type StorageMock = DeepMockProxy<StorageService>;
export type MailMock = DeepMockProxy<MailService>;
export type TokenMock = DeepMockProxy<TokenService>;
export type JwtMock = DeepMockProxy<JwtService>;

export interface ServiceHarness<T> {
  service: T;
  prisma: PrismaMock;
  storage: StorageMock;
  mail: MailMock;
  tokens: TokenMock;
  jwt: JwtMock;
  // Valores que devuelve el ConfigService falso; se puede escribir en él desde el test.
  config: Record<string, string | number>;
}

// Lo que devuelve el ConfigService falso salvo que un test lo cambie.
const CONFIG_DEFAULTS: Record<string, string | number> = {
  NODE_ENV: 'test',
  PORT: 3010,
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
  JWT_ACCESS_SECRET: 'secreto-de-prueba',
  JWT_REFRESH_SECRET: 'secreto-de-prueba',
  AWS_REGION: 'us-east-1',
  AWS_S3_BUCKET: 'bucket-de-prueba',
  AWS_ACCESS_KEY_ID: 'clave',
  AWS_SECRET_ACCESS_KEY: 'secreto',
  THROTTLE_TTL: 60_000,
  THROTTLE_LIMIT: 10,
};

// Compila un servicio con Prisma, Storage, Mail, Jwt, Token y Config sustituidos por dobles (así el test es unitario y no toca Postgres/S3/Redis/correo); deja reales PasswordService (para que signIn hashee de verdad) y ProductsService (Skus e Images dependen de él y ya tiene sus propias dependencias mockeadas).
export async function buildService<T>(
  target: Type<T>,
  extra: Provider[] = [],
): Promise<ServiceHarness<T>> {
  const prisma = createPrismaMock();
  const storage = mockDeep<StorageService>();
  const mail = mockDeep<MailService>();
  const tokens = mockDeep<TokenService>();
  const jwt = mockDeep<JwtService>();
  const config = { ...CONFIG_DEFAULTS };

  // La URL prefirmada es asíncrona y aparece en casi toda proyección de
  // producto. Sin un valor por defecto, cada test tendría que configurarla
  // aunque no le importe.
  storage.urlFor.mockImplementation((key: string) =>
    Promise.resolve(`https://s3.test/${key}?firmada`),
  );

  const configService = {
    get: <V>(key: string, fallback?: V): V | undefined =>
      (config[key] as V) ?? fallback,
    getOrThrow: <V>(key: string): V => {
      if (config[key] === undefined) {
        throw new Error(
          `Falta la variable ${key} en el ConfigService de prueba`,
        );
      }
      return config[key] as V;
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: StorageService, useValue: storage },
      { provide: MailService, useValue: mail },
      { provide: JwtService, useValue: jwt },
      { provide: ConfigService, useValue: configService },
      { provide: TokenService, useValue: tokens },
      PasswordService,
      ProductsService,
      // El objetivo va después: si coincide con alguno de arriba, gana el real.
      target,
      ...extra,
    ],
  }).compile();

  return {
    service: moduleRef.get(target),
    prisma,
    storage,
    mail,
    tokens,
    jwt,
    config,
  };
}
