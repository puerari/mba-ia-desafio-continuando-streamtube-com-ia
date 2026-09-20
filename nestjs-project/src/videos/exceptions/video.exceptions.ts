import { DomainException } from '../../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'Channel not found for the authenticated user',
    );
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 413, 'Video exceeds the maximum allowed size');
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_VIDEO_TYPE', 415, 'Unsupported video content type');
  }
}

/**
 * Also raised when a public endpoint is asked for a video that exists but is
 * not `ready` — an unknown slug and an unpublished one must be
 * indistinguishable from outside.
 */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'Video belongs to another channel');
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor() {
    super(
      'INVALID_VIDEO_STATE',
      409,
      'Video is not in a state that allows this operation',
    );
  }
}

export class RangeNotSatisfiableException extends DomainException {
  constructor(public readonly totalLength: number) {
    super('RANGE_NOT_SATISFIABLE', 416, 'Requested range is not satisfiable');
  }
}

export class SlugGenerationFailedException extends DomainException {
  constructor() {
    super(
      'SLUG_GENERATION_FAILED',
      500,
      'Could not generate a unique video slug',
    );
  }
}
