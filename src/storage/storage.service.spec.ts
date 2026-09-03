import type { ConfigService } from '@nestjs/config';
import { detectImageType, StorageService } from './storage.service';

// Firmas reales de los tres tipos aceptados, mínimas pero completas para
// pasar la verificación (el resto de bytes de una imagen real no importa
// aquí, sólo la cabecera).
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);

describe('detectImageType', () => {
  it('reconoce un PNG por su firma de 8 bytes', () => {
    expect(detectImageType(PNG_BYTES)).toBe('image/png');
  });

  it('reconoce un JPEG por su firma de 3 bytes', () => {
    expect(detectImageType(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('reconoce un WEBP por RIFF....WEBP', () => {
    expect(detectImageType(WEBP_BYTES)).toBe('image/webp');
  });

  it('no reconoce un buffer sin firma válida, aunque declare texto plano', () => {
    expect(detectImageType(Buffer.from('no soy una imagen'))).toBeUndefined();
  });

  it('no reconoce un SVG disfrazado de PNG por su mimetype', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectImageType(svg)).toBeUndefined();
  });

  it('no revienta con un buffer más corto que la firma más larga', () => {
    expect(detectImageType(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  it('no confunde un RIFF que no es WEBP (por ejemplo, un WAV)', () => {
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

  it('deriva la extensión del tipo verificado, no de un nombre de archivo', () => {
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
