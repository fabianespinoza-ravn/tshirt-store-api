import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extname } from 'node:path';
import { newId } from '../common/ids';

// Tipos y techo tal como los declara el contrato, para poder rechazar antes de subir.
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Una hora basta para una respuesta de API; el correo de reposición de F8 necesita otra vía porque se lee días después, cuando la credencial de firma ya expiró (hallazgo 15).
const SIGNED_URL_TTL_SECONDS = 3600;

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('AWS_S3_ENDPOINT');

    this.bucket = config.getOrThrow<string>('AWS_S3_BUCKET');
    this.client = new S3Client({
      region: config.getOrThrow<string>('AWS_REGION'),
      // Con endpoint propio hace falta el estilo de ruta: MinIO no resuelve
      // buckets como subdominio. Sin endpoint, el SDK habla con AWS de verdad y
      // usa el estilo virtual, que es su valor por defecto.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  // La clave la elige el servidor, no el cliente: un nombre externo podría traer `../` o pisar un objeto existente.
  buildKey(productId: string, originalName: string): string {
    const ext = extname(originalName).toLowerCase().slice(0, 8);
    return `products/${productId}/${newId()}${ext}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  // URL de lectura temporal, necesaria porque el bucket no es público.
  urlFor(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
  }
}
