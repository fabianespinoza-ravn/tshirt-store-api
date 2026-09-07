import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  type AcceptedImageType,
  type StorageService,
} from '../storage/storage.service';
import {
  SWEEP_EVERY_MS,
  STOCK_NOTIFICATION_JOB_OPTIONS,
} from '../queue/queue.constants';
import {
  loadImageAttachment,
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
 * The chunk size `aBodyStream` and `anObservableBody` hand the body over in,
 * named because the cases about where the read stops are stated in chunks.
 */
const CHUNK_BYTES = 64 * 1024;

/**
 * A body delivered the way `fetch` delivers one — a stream, in chunks —
 * because a stream is what the function now reads. Handing it one finished
 * buffer would let a case pass a cap it could not pass in production, where
 * the whole object is never in hand to be measured.
 */
export const aBodyStream = (
  bytes: Buffer,
  chunkSize = CHUNK_BYTES,
): ReadableStream<Uint8Array<ArrayBuffer>> =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (let at = 0; at < bytes.byteLength; at += chunkSize) {
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + chunkSize)));
      }
      controller.close();
    },
  });

/**
 * The same body, plus the two things the cap's branches are actually about:
 * how much of it the code pulled, and whether it cancelled the rest.
 *
 * The queuing strategy holds nothing back, so the source is pulled exactly
 * once per `read()` and `bytesPulled` is what the code asked the stream for
 * rather than what the stream volunteered. That is what lets a case say
 * "it stopped here" instead of only "it failed".
 */
export const anObservableBody = (bytes: Buffer, chunkSize = CHUNK_BYTES) => {
  const chunks: Uint8Array<ArrayBuffer>[] = [];

  for (let at = 0; at < bytes.byteLength; at += chunkSize) {
    chunks.push(new Uint8Array(bytes.subarray(at, at + chunkSize)));
  }

  let pulled = 0;
  let bytesPulled = 0;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(controller) {
        const chunk = chunks[pulled];

        if (chunk === undefined) {
          controller.close();
          return;
        }

        pulled += 1;
        bytesPulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    chunksPulled: () => pulled,
    bytesPulled: () => bytesPulled,
    wasCancelled: () => cancelled,
  };
};

/**
 * An accepted answer whose body is handed over rather than built from bytes,
 * so a case can question the stream afterwards — or state that there is no
 * body at all, which is a thing a 200 can do and the code has a branch for.
 */
export const anOkResponseWithBody = (
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null,
  headers: Record<string, string> = {},
): Partial<Response> => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'image/png', ...headers }),
  body,
});

/**
 * Replaces `fetch` for one case. The object it returns is only as much of
 * `Response` as this function reads — `ok`, `status`, `headers` and `body`
 * — which is deliberate: a fuller double would let a case pass while
 * depending on a field the code never looks at.
 */
export const stubFetch = (answer: Partial<Response> | Error) => {
  const spy = jest.spyOn(globalThis, 'fetch');
  return answer instanceof Error
    ? spy.mockRejectedValue(answer)
    : spy.mockResolvedValue(answer as unknown as Response);
};

/**
 * The extra headers are a third argument rather than a `contentLength` one
 * so that a case can state a `Content-Length` that is absent, wrong, or not
 * a number at all — which is the whole reason the code treats it as a hint.
 */
export const anOkResponse = (
  bytes: Buffer,
  contentType: string | null = 'image/png',
  headers: Record<string, string> = {},
): Partial<Response> => ({
  ok: true,
  status: 200,
  headers: new Headers({
    ...(contentType ? { 'content-type': contentType } : {}),
    ...headers,
  }),
  body: aBodyStream(bytes),
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
  /** The shape of key `StorageService.buildKey` produces. */
  const aKey = (extension = '.png'): string =>
    `products/product-1/image-1${extension}`;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('reading the object', () => {
    it('asks storage for a URL for the key it was given', async () => {
      const storage = aStorage();
      stubFetch(anOkResponse(bytesOf(8)));

      await loadImageAttachment(storage, aKey());

      expect(storage.urlFor).toHaveBeenCalledWith(aKey());
    });

    it('returns the object base64-encoded, which is what a job can hold', async () => {
      const bytes = bytesOf(24);
      stubFetch(anOkResponse(bytes));

      const attachment = await loadImageAttachment(aStorage(), aKey());

      expect(attachment.content).toBe(bytes.toString('base64'));
      expect(Buffer.from(attachment.content, 'base64')).toEqual(bytes);
    });

    it('names the attachment after the object, not after the whole key', async () => {
      stubFetch(anOkResponse(bytesOf(8)));

      const attachment = await loadImageAttachment(aStorage(), aKey());

      expect(attachment.filename).toBe('image-1.png');
    });
  });

  describe('deciding what kind of image it is', () => {
    it('uses the content type the object was stored with', async () => {
      stubFetch(anOkResponse(bytesOf(8), 'image/webp'));

      // The key says PNG and the object says WebP: the stored type wins,
      // because that is the one `StorageService.put` was given after the
      // magic bytes were verified.
      const attachment = await loadImageAttachment(aStorage(), aKey('.png'));

      expect(attachment.contentType).toBe('image/webp');
    });

    it('falls back to the extension of the key when the response declares none', async () => {
      stubFetch(anOkResponse(bytesOf(8), null));

      const attachment = await loadImageAttachment(aStorage(), aKey('.jpg'));

      expect(attachment.contentType).toBe('image/jpeg');
    });

    it('falls back to the extension when the response declares something that is not an image', async () => {
      stubFetch(anOkResponse(bytesOf(8), 'application/octet-stream'));

      const attachment = await loadImageAttachment(aStorage(), aKey('.webp'));

      expect(attachment.contentType).toBe('image/webp');
    });

    it('resolves each extension storage is able to produce', async () => {
      const extensionByType: Record<AcceptedImageType, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
      };

      // A fourth accepted type has to be decided on here rather than
      // silently losing its picture.
      expect(Object.keys(extensionByType).sort()).toEqual(
        [...ACCEPTED_IMAGE_TYPES].sort(),
      );

      for (const [type, extension] of Object.entries(extensionByType)) {
        stubFetch(anOkResponse(bytesOf(8), null));

        const attachment = await loadImageAttachment(
          aStorage(),
          aKey(extension),
        );

        expect(attachment.contentType).toBe(type);
        jest.restoreAllMocks();
      }
    });

    it('throws when neither the response nor the key identifies a type', async () => {
      stubFetch(anOkResponse(bytesOf(8), null));

      await expect(
        loadImageAttachment(aStorage(), aKey('.gif')),
      ).rejects.toThrow(`Cannot tell what kind of image ${aKey('.gif')} is.`);
    });
  });

  describe('the failures the caller is expected to absorb', () => {
    it('throws, naming the status, when storage answers a failure', async () => {
      stubFetch({ ok: false, status: 403, headers: new Headers() });

      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        `Storage answered 403 for ${aKey()}.`,
      );
    });

    it('lets a network error out rather than turning it into an empty attachment', async () => {
      stubFetch(new Error('getaddrinfo ENOTFOUND s3.test'));

      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        'getaddrinfo ENOTFOUND s3.test',
      );
    });

    it(`abandons the read after ${IMAGE_FETCH_TIMEOUT_MS}ms rather than holding the job`, async () => {
      const signal = AbortSignal.abort();
      const timeout = jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(signal);
      const fetched = stubFetch(anOkResponse(bytesOf(8)));

      await loadImageAttachment(aStorage(), aKey());

      expect(timeout).toHaveBeenCalledWith(IMAGE_FETCH_TIMEOUT_MS);
      // The bound has to reach `fetch` rather than merely be constructed:
      // the signal handed over is the one the timeout produced, and it is
      // the only option the read is given.
      expect(fetched.mock.calls[0]?.[1]).toEqual({ signal });
    });

    it(`throws for an object over ${MAX_ATTACHMENT_BYTES} bytes, naming the size and the cap`, async () => {
      const oversized = MAX_ATTACHMENT_BYTES + 1;
      stubFetch(anOkResponse(bytesOf(oversized)));

      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        `${aKey()} is ${oversized} bytes, over the ${MAX_ATTACHMENT_BYTES} an attachment may be.`,
      );
    });

    it(`accepts an object of exactly ${MAX_ATTACHMENT_BYTES} bytes`, async () => {
      const bytes = bytesOf(MAX_ATTACHMENT_BYTES);
      stubFetch(anOkResponse(bytes));

      const attachment = await loadImageAttachment(aStorage(), aKey());

      expect(Buffer.from(attachment.content, 'base64').byteLength).toBe(
        MAX_ATTACHMENT_BYTES,
      );
    });
  });

  /**
   * The cap used to be measured against a buffer the whole object had
   * already been read into, so it bounded what reached Redis and nothing at
   * all in the worker holding the job. It is now applied to the bytes as
   * they arrive, which adds the branches below.
   *
   * Per CLAUDE.md the assertions are the student's to write: the behaviour
   * these name was generated, and an assertion written alongside it would
   * only restate it, bugs included.
   */
  describe('the cap, which bounds the read and not only the payload', () => {
    /** Where the running count crosses the cap, counted in whole chunks. */
    const chunksToCross = Math.floor(MAX_ATTACHMENT_BYTES / CHUNK_BYTES) + 1;
    const bytesAtCrossing = chunksToCross * CHUNK_BYTES;

    /** What `readCapped` names when it refuses `size` bytes. */
    const refusal = (size: number, key = aKey()): string =>
      `${key} is ${size} bytes, over the ${MAX_ATTACHMENT_BYTES} an attachment may be.`;

    it('refuses on a Content-Length over the cap, without reading the body', async () => {
      const declared = MAX_ATTACHMENT_BYTES + 1;
      // Eight bytes would have fitted with room to spare, so a refusal that
      // names `declared` can only have come from the header.
      const body = anObservableBody(bytesOf(8));
      stubFetch(
        anOkResponseWithBody(body.stream, {
          'content-length': String(declared),
        }),
      );

      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        refusal(declared),
      );
      expect(body.chunksPulled()).toBe(0);
      expect(body.bytesPulled()).toBe(0);
    });

    it('cancels the body it refused on the declared length, rather than draining it', async () => {
      const declared = MAX_ATTACHMENT_BYTES * 2;
      const body = anObservableBody(bytesOf(declared));
      stubFetch(
        anOkResponseWithBody(body.stream, {
          'content-length': String(declared),
        }),
      );

      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        refusal(declared),
      );
      // Cancelled, not drained: the source was told to stop and not one byte
      // of it was pulled. Returning early without cancelling would leave the
      // rest of the object still coming down the connection.
      expect(body.wasCancelled()).toBe(true);
      expect(body.bytesPulled()).toBe(0);
    });

    it('reads the object normally when the Content-Length fits', async () => {
      const bytes = bytesOf(MAX_ATTACHMENT_BYTES - 1);
      const body = anObservableBody(bytes);
      stubFetch(
        anOkResponseWithBody(body.stream, {
          'content-length': String(bytes.byteLength),
        }),
      );

      const attachment = await loadImageAttachment(aStorage(), aKey());

      expect(attachment.content).toBe(bytes.toString('base64'));
      // A declared length under the cap refuses nothing and truncates
      // nothing: every byte was pulled and the stream ran to its end.
      expect(body.bytesPulled()).toBe(bytes.byteLength);
      expect(body.wasCancelled()).toBe(false);
    });

    it('ignores a Content-Length that is not a number and counts the bytes instead', async () => {
      const bytes = bytesOf(CHUNK_BYTES);
      const body = anObservableBody(bytes);
      // A header that is a size only to something that parses a prefix:
      // `Number` says NaN and the hint is dropped, while `parseInt` would
      // read a number over the cap and refuse an object that fits.
      stubFetch(
        anOkResponseWithBody(body.stream, {
          'content-length': `${MAX_ATTACHMENT_BYTES + 1}kB`,
        }),
      );

      const attachment = await loadImageAttachment(aStorage(), aKey());

      expect(attachment.content).toBe(bytes.toString('base64'));
      expect(body.bytesPulled()).toBe(bytes.byteLength);
    });

    it('refuses an object whose Content-Length understates it, because the count decides', async () => {
      const oversized = MAX_ATTACHMENT_BYTES + 1;
      const body = anObservableBody(bytesOf(oversized));
      stubFetch(anOkResponseWithBody(body.stream, { 'content-length': '8' }));

      // The declared eight bytes would admit it; the running count refuses
      // it, and the size it names is the one it counted, not the one it was
      // told.
      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        refusal(oversized),
      );
      expect(body.bytesPulled()).toBe(oversized);
    });

    it('stops on the chunk that crosses the cap rather than buffering what follows', async () => {
      const oversized = MAX_ATTACHMENT_BYTES * 4;
      const body = anObservableBody(bytesOf(oversized));
      stubFetch(anOkResponseWithBody(body.stream));

      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        refusal(bytesAtCrossing),
      );
      // The property the cap has only because it is applied to the read: it
      // stopped one chunk past the cap and cancelled the rest, so the heap
      // never held the object. Measuring a finished buffer would have
      // pulled all of it first.
      expect(bytesAtCrossing).toBeLessThan(oversized);
      expect(body.chunksPulled()).toBe(chunksToCross);
      expect(body.bytesPulled()).toBe(bytesAtCrossing);
      expect(body.wasCancelled()).toBe(true);
    });

    it('throws when a successful response carries no body', async () => {
      stubFetch(anOkResponseWithBody(null));

      await expect(loadImageAttachment(aStorage(), aKey())).rejects.toThrow(
        `Storage answered ${aKey()} without a body.`,
      );
    });
  });

  describe('the two numbers, which are decisions', () => {
    it('keeps the attachment cap well under storage MAX_IMAGE_BYTES, because the payload is copied per recipient', () => {
      expect(MAX_ATTACHMENT_BYTES).toBeLessThan(MAX_IMAGE_BYTES);
      // Base64 inflates by a third and the result is copied once per
      // recipient, so a cap anywhere near what storage accepts would put a
      // gigabyte through Redis for one crossing.
      expect(MAX_ATTACHMENT_BYTES * (4 / 3)).toBeLessThan(MAX_IMAGE_BYTES / 4);
    });

    it('bounds the read, because an unreachable bucket must not hold a worker', () => {
      const attempts = STOCK_NOTIFICATION_JOB_OPTIONS.attempts ?? 1;

      expect(Number.isFinite(IMAGE_FETCH_TIMEOUT_MS)).toBe(true);
      expect(IMAGE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
      // Every attempt of the job pays this wait once, and the run as a whole
      // has to stay shorter than the interval the sweep already treats as
      // the longest a background job may reasonably take.
      expect(IMAGE_FETCH_TIMEOUT_MS * attempts).toBeLessThan(SWEEP_EVERY_MS);
    });
  });
});
