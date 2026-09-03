import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

// Numeric properties carry an explicit ": number" on purpose: without the
// annotation, design:type is Object and enableImplicitConversion doesn't
// know how to convert the environment's string, so @IsInt() fails, and only
// when the variable is present because the default value is already a
// number.
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_HOST!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number = 6379;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_TTL!: string;

  // Empty in development reflects the request's origin; empty in production
  // allows none, which is the safe failure.
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Rate limit window, in milliseconds. Throttler v5+ uses ms. */
  @IsInt()
  @Min(1000)
  THROTTLE_TTL: number = 60_000;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 10;

  // Images are on the catalog's critical path, so these variables aren't
  // optional the way Stripe's are; AWS_S3_ENDPOINT is: present points at the
  // local MinIO, absent lets the SDK resolve the real AWS host.
  @IsString()
  @IsNotEmpty()
  AWS_REGION!: string;

  @IsString()
  @IsNotEmpty()
  AWS_S3_BUCKET!: string;

  @IsOptional()
  @IsString()
  AWS_S3_ENDPOINT?: string;

  @IsString()
  @IsNotEmpty()
  AWS_ACCESS_KEY_ID!: string;

  @IsString()
  @IsNotEmpty()
  AWS_SECRET_ACCESS_KEY!: string;

  // Stripe and email come in when their features do. Optional until then so
  // the week 3 checkpoint can boot without them.
  @IsOptional()
  @IsString()
  STRIPE_SECRET_KEY?: string;

  @IsOptional()
  @IsString()
  STRIPE_WEBHOOK_SECRET?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const detail = errors
      .map(
        (e) =>
          `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  return validated;
}
