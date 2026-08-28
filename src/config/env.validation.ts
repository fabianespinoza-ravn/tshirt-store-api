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

// Las propiedades numéricas llevan ": number" explícito a propósito: sin la anotación, design:type es Object y enableImplicitConversion no sabe convertir la cadena del entorno, así que @IsInt() falla, y sólo cuando la variable está presente porque el valor por defecto ya es un número.
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

  // Vacío en desarrollo refleja el origen de la petición; vacío en producción no permite ninguno, que es el fallo seguro.
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Ventana del límite de peticiones, en milisegundos. Throttler v5+ usa ms. */
  @IsInt()
  @Min(1000)
  THROTTLE_TTL: number = 60_000;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 10;

  // Las imágenes están en el camino crítico del catálogo, así que estas variables no son opcionales como las de Stripe; AWS_S3_ENDPOINT sí lo es: presente apunta al MinIO local, ausente deja que el SDK resuelva el host real de AWS.
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

  // Stripe y el correo entran cuando lleguen sus features. Opcionales hasta
  // entonces para que el checkpoint de la semana 3 arranque sin ellas.
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
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
  }

  return validated;
}
