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
  // Values the fake ConfigService returns; a test can write to it directly.
  config: Record<string, string | number>;
}

// What the fake ConfigService returns unless a test changes it.
const CONFIG_DEFAULTS: Record<string, string | number> = {
  NODE_ENV: 'test',
  PORT: 3010,
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
  JWT_ACCESS_SECRET: 'test-secret',
  JWT_REFRESH_SECRET: 'test-secret',
  AWS_REGION: 'us-east-1',
  AWS_S3_BUCKET: 'test-bucket',
  AWS_ACCESS_KEY_ID: 'key',
  AWS_SECRET_ACCESS_KEY: 'secret',
  THROTTLE_TTL: 60_000,
  THROTTLE_LIMIT: 10,
};

// Compiles a service with Prisma, Storage, Mail, Jwt, Token and Config
// replaced by doubles (so the test stays unit-level and never touches
// Postgres/S3/Redis/mail); keeps real PasswordService (so signIn actually
// hashes) and ProductsService (Skus and Images depend on it, and it already
// has its own dependencies mocked).
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

  // The presigned URL is asynchronous and shows up in almost every product
  // projection. Without a default, every test would have to configure it
  // even when it doesn't care.
  storage.urlFor.mockImplementation((key: string) =>
    Promise.resolve(`https://s3.test/${key}?signed`),
  );

  const configService = {
    get: <V>(key: string, fallback?: V): V | undefined =>
      (config[key] as V) ?? fallback,
    getOrThrow: <V>(key: string): V => {
      if (config[key] === undefined) {
        throw new Error(`Missing variable ${key} in the test ConfigService`);
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
      // The target goes last: if it collides with any of the above, the
      // real one wins.
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
