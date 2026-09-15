import type { ConfigService } from '@nestjs/config';
import { detectImageType, StorageService } from './storage.service';

// Real signatures of the three accepted types, minimal but complete enough
// to pass verification (the rest of a real image's bytes don't matter here,
// only the header).
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);

describe('detectImageType', () => {
  it('recognises a PNG by its 8-byte signature', () => {
    expect(detectImageType(PNG_BYTES)).toBe('image/png');
  });

  it('recognises a JPEG by its 3-byte signature', () => {
    expect(detectImageType(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('recognises a WEBP by RIFF....WEBP', () => {
    expect(detectImageType(WEBP_BYTES)).toBe('image/webp');
  });

  it('does not recognise a buffer with no valid signature, even if it claims to be plain text', () => {
    expect(detectImageType(Buffer.from('not an image'))).toBeUndefined();
  });

  it('does not recognise an SVG disguised as a PNG by its mimetype', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectImageType(svg)).toBeUndefined();
  });

  it('does not blow up on a buffer shorter than the longest signature', () => {
    expect(detectImageType(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  it('does not confuse a RIFF that is not WEBP (a WAV, for instance)', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(detectImageType(wav)).toBeUndefined();
  });
});

describe('StorageService.buildKey', () => {
  const config = {
    get: () => undefined,
    getOrThrow: (key: string) => `fake-${key}`,
  } as unknown as ConfigService;

  it('derives the extension from the verified type, not from a filename', () => {
    const storage = new StorageService(config);

    expect(storage.buildKey('product-1', 'image/png')).toMatch(
      /^products\/product-1\/[0-9a-f-]+\.png$/,
    );
    expect(storage.buildKey('product-1', 'image/jpeg')).toMatch(
      /^products\/product-1\/[0-9a-f-]+\.jpg$/,
    );
    expect(storage.buildKey('product-1', 'image/webp')).toMatch(
      /^products\/product-1\/[0-9a-f-]+\.webp$/,
    );
  });
});
