import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '../common/ids';

// Tipos y techo tal como los declara el contrato, para poder rechazar antes de subir.
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Extensión que corresponde a cada tipo verificado, nunca al `originalname` que
// manda el cliente: ese campo no pasa por ninguna validación y `x.svg` con
// `mimetype: image/png` terminaría guardado como `.svg`.
const EXTENSION_BY_TYPE: Record<AcceptedImageType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Firma de los primeros bytes de cada tipo aceptado. Es la única verificación
// real: `file.mimetype` lo declara el cliente en la petición multipart y
// Multer nunca mira el contenido, así que confiar en ese campo a solas deja
// subir cualquier byte bajo la etiqueta que el atacante prefiera. No usamos el
// paquete `file-type` porque sus versiones recientes son ESM puro y este build
// es CommonJS; para tres firmas fijas alcanza con mirar los bytes a mano.
export function detectImageType(buffer: Buffer): AcceptedImageType | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  // RIFF....WEBP: las cuatro letras de WEBP quedan en el byte 8, después del
  // tamaño del chunk en little-endian, no al principio del buffer.
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return undefined;
}

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

  // La clave la elige el servidor, no el cliente: un nombre externo podría
  // traer `../` o pisar un objeto existente. La extensión sale del tipo ya
  // verificado por `detectImageType`, no de `file.originalname`.
  buildKey(productId: string, type: AcceptedImageType): string {
    return `products/${productId}/${newId()}${EXTENSION_BY_TYPE[type]}`;
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
