/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getFrameController,
  type FrameController,
  type ReadonlyFrame,
  type ScreenSelection,
} from 'ink';

/**
 * Read side of the frame-buffer bridge. Wraps Ink's {@link FrameController} to
 * answer "what character is at (x, y)" against the latest composited frame and
 * to push a selection range that the renderer highlights before serialization.
 *
 * This is the foundation the selection state machine (M1) builds on; it does
 * not itself own any mouse or keyboard handling.
 */
export class ScreenBuffer {
  constructor(private readonly controller: FrameController) {}

  get frame(): ReadonlyFrame | null {
    return this.controller.getFrame();
  }

  get dimensions(): { width: number; height: number } {
    const frame = this.frame;
    return { width: frame?.width ?? 0, height: frame?.height ?? 0 };
  }

  /** Visual text of a row, with trailing padding trimmed. */
  lineText(y: number): string {
    const row = this.frame?.cells[y];
    if (!row) {
      return '';
    }
    return row
      .map((cell) => cell.value)
      .join('')
      .replace(/\s+$/u, '');
  }

  setSelection(selection: ScreenSelection | null): void {
    this.controller.setSelection(selection);
  }

  subscribe(listener: (frame: ReadonlyFrame) => void): () => void {
    return this.controller.subscribe(listener);
  }
}

/**
 * Returns the screen buffer for the given output stream, or `undefined` if no
 * Ink instance is rendering to it (e.g. non-TTY or before render).
 */
export function getScreenBuffer(
  stdout: NodeJS.WriteStream,
): ScreenBuffer | undefined {
  const controller = getFrameController(stdout);
  return controller ? new ScreenBuffer(controller) : undefined;
}
