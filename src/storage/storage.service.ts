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

// Types and ceiling exactly as the contract declares them, so we can reject
// before uploading.
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Extension that matches each verified type, never the client-supplied
// `originalname`: that field goes through no validation, and `x.svg` with
// `mimetype: image/png` would end up stored as `.svg`.
const EXTENSION_BY_TYPE: Record<AcceptedImageType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Signature of the first bytes of each accepted type. This is the only real
// verification: `file.mimetype` is declared by the client in the multipart
// request and Multer never looks at the content, so trusting that field
// alone lets an attacker upload any bytes under whatever label they prefer.
// We don't use the `file-type` package because its recent versions are pure
// ESM and this build is CommonJS; for three fixed signatures, checking the
// bytes by hand is enough.
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

  // RIFF....WEBP: the four letters of WEBP sit at byte 8, after the
  // little-endian chunk size, not at the start of the buffer.
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return undefined;
}

// One hour is enough for an API response; F8's restock email needs another
// route because it's read days later, once the signing credential has
// already expired (finding 15).
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
      // A custom endpoint needs path-style: MinIO doesn't resolve buckets as
      // a subdomain. With no endpoint, the SDK talks to real AWS and uses
      // virtual-hosted style, which is its default.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  // The server picks the key, not the client: an external name could carry
  // `../` or overwrite an existing object. The extension comes from the
  // type already verified by `detectImageType`, not from
  // `file.originalname`.
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

  // Temporary read URL, needed because the bucket isn't public.
  urlFor(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
  }
}
