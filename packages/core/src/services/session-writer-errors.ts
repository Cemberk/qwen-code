/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type SessionWriterErrorKind =
  | 'session_transcript_changed'
  | 'session_writer_unavailable';

export abstract class SessionWriterError extends Error {
  abstract readonly errorKind: SessionWriterErrorKind;
}

export class SessionTranscriptChangedError extends SessionWriterError {
  override readonly name = 'SessionTranscriptChangedError';
  readonly errorKind = 'session_transcript_changed';

  constructor() {
    super('The session transcript changed outside its active writer.');
  }
}

export class SessionWriterUnavailableError extends SessionWriterError {
  // Widened from the literal type so the subclass below can redeclare `name`.
  // Narrowing this back to a literal makes that subclass fail to compile.
  override readonly name: string = 'SessionWriterUnavailableError';
  readonly errorKind = 'session_writer_unavailable';

  constructor(options?: ErrorOptions & { message?: string }) {
    super(
      options?.message ?? 'Session write ownership could not be verified.',
      options,
    );
  }
}

export class SessionTranscriptIdentityUnavailableError extends SessionWriterUnavailableError {
  override readonly name = 'SessionTranscriptIdentityUnavailableError';

  constructor(cause?: Error) {
    super({
      message:
        'Session transcript identity could not be verified on this filesystem.',
      cause:
        cause ??
        new Error(
          'The session transcript filesystem does not provide a verifiable inode identity (ino=0).',
        ),
    });
  }
}
