import { basename, extname } from 'node:path';
import type { MailAttachment } from '../mail/mail.jobs';
import type { StorageService } from '../storage/storage.service';

/**
 * Why the image is attached rather than linked.
 *
 * Finding 15 of docs/DESIGN-ATTACK.md measured it: a SigV4 presigned URL
 * lives at most seven days, and if it was signed with *temporary*
 * credentials — which is what an IAM role on any container platform hands
 * out — it dies with the credential instead, in hours. The bucket is not
 * public. An email is read whenever its owner gets round to it, so a link is
 * a picture that works for the recipients who open it quickly and is broken
 * for everybody else, with nothing to distinguish the two. Bytes in the
 * message do not expire.
 *
 * `MailAttachment` was added in block 4 anticipating exactly this, and
 * `MailTransport` already turns its base64 back into a Buffer.
 */

/**
 * Well under `MAX_IMAGE_BYTES`, on purpose.
 *
 * Storage accepts a 5 MB upload; base64 inflates that by a third, and this
 * payload is then copied once per recipient into the mail queue. A fan-out
 * of two hundred likers would put well over a gigabyte through Redis for one
 * crossing. A message that arrives without its picture is a smaller failure
 * than a queue that cannot hold the messages, so the large image is dropped
 * and the send continues.
 *
 * It bounds the worker's heap as well as the queue's payload, and that is a
 * property of *how* it is applied rather than of the number: the body is
 * counted as it arrives and the read is abandoned on the chunk that crosses
 * the cap, so an object too large to send is never assembled. Reading the
 * whole object and measuring it afterwards would have capped what reaches
 * Redis and capped nothing at all in the process holding the job — which is
 * the process that also holds every other job on the queue.
 */
export const MAX_ATTACHMENT_BYTES = 512 * 1024;

/**
 * S3 is a network hop taken while a worker holds a job. Without a bound, an
 * unreachable bucket turns a three-attempt job into three long hangs.
 *
 * The signal covers the body as well as the headers, so a bucket that
 * answers and then trickles is bounded by the same number as one that never
 * answers at all.
 */
export const IMAGE_FETCH_TIMEOUT_MS = 5_000;

/**
 * `StorageService` publishes `buildKey` and `urlFor` and no way to read an
 * object's bytes, so the presigned URL is fetched immediately and used
 * immediately — the expiry that makes a link useless in an inbox is
 * irrelevant over the milliseconds it takes to read it here.
 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * The size the response claims, when it claims one that can be read as a
 * size at all.
 *
 * `Content-Length` is a hint and this function treats it as one. It is
 * **absent** on a chunked response, and it can **lie**: an intermediary is
 * free to state a number the body does not honour. So it is used in one
 * direction only — to refuse early, never to accept. Missing, unparseable
 * or understated, nothing is lost, because `readCapped` counts the bytes it
 * actually receives and that count is what enforces the cap. Overstated,
 * a picture is dropped for an object that would have fitted, which is the
 * failure this whole function exists to absorb.
 */
const declaredLengthOf = (response: Response): number | undefined => {
  const header = response.headers.get('content-length');

  if (header === null) return undefined;

  const length = Number(header);

  return Number.isInteger(length) && length >= 0 ? length : undefined;
};

/**
 * Reads a response body, refusing rather than returning more than
 * `MAX_ATTACHMENT_BYTES`.
 *
 * The bound is on the bytes held, not on the bytes measured afterwards: the
 * loop stops on the first chunk that carries the total past the cap and
 * cancels the rest, so the most this ever holds is the cap plus one chunk.
 *
 * The size the error names is where the read stopped, which for a body cut
 * short is a lower bound on the object rather than its size. That is all
 * the caller's log needs — which object was refused, and that it was too
 * big — and the alternative is reading the whole thing to be able to print
 * an exact number, which is the defect this replaced.
 */
const readCapped = async (
  response: Response,
  s3Key: string,
): Promise<Buffer> => {
  const tooLarge = (size: number): Error =>
    new Error(
      `${s3Key} is ${size} bytes, over the ${MAX_ATTACHMENT_BYTES} an attachment may be.`,
    );

  const declared = declaredLengthOf(response);

  if (declared !== undefined && declared > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel();
    throw tooLarge(declared);
  }

  if (!response.body) {
    throw new Error(`Storage answered ${s3Key} without a body.`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    read += value.byteLength;

    if (read > MAX_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw tooLarge(read);
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks, read);
};

/**
 * Reads a stored product image into a mail attachment.
 *
 * It **throws** on every way this can go wrong rather than returning
 * `undefined`, so the reason survives as far as the caller's log. The caller
 * is expected to catch it and send the message without a picture: a
 * notification that never arrives because of a photograph is a worse outcome
 * than one that arrives plain, and S3 being unreachable is not a reason to
 * retry a job whose real work is an email.
 */
export async function loadImageAttachment(
  storage: StorageService,
  s3Key: string,
): Promise<MailAttachment> {
  const url = await storage.urlFor(s3Key);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Storage answered ${response.status} for ${s3Key}.`);
  }

  const bytes = await readCapped(response, s3Key);

  // The declared type wins when the object carries one, because that is what
  // `StorageService.put` was told the verified magic bytes said. The
  // extension is the fallback, and it is a safe one: the key is built by
  // `buildKey` from that same verified type and never from a client-supplied
  // filename.
  const declared = response.headers.get('content-type');
  const contentType = declared?.startsWith('image/')
    ? declared
    : CONTENT_TYPE_BY_EXTENSION[extname(s3Key).toLowerCase()];

  if (!contentType) {
    throw new Error(`Cannot tell what kind of image ${s3Key} is.`);
  }

  return {
    filename: basename(s3Key),
    content: bytes.toString('base64'),
    contentType,
  };
}
