import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import type { StorageService } from '../storage/storage.service';
import {
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
} from './product-image.attachment';

/**
 * A storage double whose `urlFor` answers a presigned-looking URL, the same
 * default `buildService` installs for every other suite that touches S3.
 */
export const aStorage = (): DeepMockProxy<StorageService> => {
  const storage = mockDeep<StorageService>();
  storage.urlFor.mockImplementation((key: string) =>
    Promise.resolve(`https://s3.test/${key}?signed`),
  );
  return storage;
};

/** A body of a given size, so the cap can be approached from both sides. */
export const bytesOf = (size: number): Buffer => Buffer.alloc(size, 0x2a);

/**
 * Replaces `fetch` for one case. The object it returns is only as much of
 * `Response` as this function reads — `ok`, `status`, `headers` and
 * `arrayBuffer` — which is deliberate: a fuller double would let a case pass
 * while depending on a field the code never looks at.
 */
export const stubFetch = (
  answer: Partial<Response> | Error,
): jest.SpyInstance => {
  const spy = jest.spyOn(globalThis, 'fetch');
  return answer instanceof Error
    ? spy.mockRejectedValue(answer)
    : spy.mockResolvedValue(answer as unknown as Response);
};

export const anOkResponse = (
  bytes: Buffer,
  contentType: string | null = 'image/png',
): Partial<Response> => ({
  ok: true,
  status: 200,
  headers: new Headers(contentType ? { 'content-type': contentType } : {}),
  arrayBuffer: () =>
    Promise.resolve(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    ),
});

/**
 * The one piece of this feature that reaches outside the process while a
 * worker is holding a job.
 *
 * It throws on every failure rather than returning nothing, and that is the
 * contract these cases pin: the caller catches, logs the reason and sends
 * the message anyway. If this ever returned `undefined` instead, the reason
 * a picture went missing would stop existing anywhere.
 *
 * The two numbers are worth a case each for the reason
 * `queue.constants.spec.ts` gives about the job policies: both are values,
 * both were chosen against a measured consequence — a base64 payload copied
 * once per recipient through Redis, and a worker blocked on an unreachable
 * bucket — and nothing else in the suite would go red if either were tidied
 * away.
 */
describe('the product image attachment', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('reading the object', () => {
    it.todo('asks storage for a URL for the key it was given');

    it.todo('returns the object base64-encoded, which is what a job can hold');

    it.todo('names the attachment after the object, not after the whole key');
  });

  describe('deciding what kind of image it is', () => {
    it.todo('uses the content type the object was stored with');

    it.todo(
      'falls back to the extension of the key when the response declares none',
    );

    it.todo(
      'falls back to the extension when the response declares something that is not an image',
    );

    it.todo('resolves each extension storage is able to produce');

    it.todo('throws when neither the response nor the key identifies a type');
  });

  describe('the failures the caller is expected to absorb', () => {
    it.todo('throws, naming the status, when storage answers a failure');

    it.todo(
      'lets a network error out rather than turning it into an empty attachment',
    );

    it.todo(
      `abandons the read after ${IMAGE_FETCH_TIMEOUT_MS}ms rather than holding the job`,
    );

    it.todo(
      `throws for an object over ${MAX_ATTACHMENT_BYTES} bytes, naming the size and the cap`,
    );

    it.todo(`accepts an object of exactly ${MAX_ATTACHMENT_BYTES} bytes`);
  });

  describe('the two numbers, which are decisions', () => {
    it.todo(
      'keeps the attachment cap well under storage MAX_IMAGE_BYTES, because the payload is copied per recipient',
    );

    it.todo(
      'bounds the read, because an unreachable bucket must not hold a worker',
    );
  });
});
