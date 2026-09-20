import type { Readable } from 'node:stream';

/** A part already uploaded by the client, as returned by storage. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** A presigned URL for a single part of a multipart upload. */
export interface PresignedPart {
  partNumber: number;
  url: string;
}

/**
 * The result of a (possibly ranged) object read.
 *
 * `contentLength` is the size of the slice actually returned, while
 * `totalLength` is the size of the whole object — the two differ on a ranged
 * read and both are needed to build a correct `206` response.
 */
export interface ObjectStreamResult {
  stream: Readable;
  contentLength: number;
  totalLength: number;
  contentRange?: string;
  contentType?: string;
}
