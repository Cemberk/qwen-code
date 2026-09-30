/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import { escapeJsonTagCharacters } from '@qwen-code/qwen-code-core';
import type { InsightData } from '../types/StaticInsightTypes.js';

export class TemplateRenderer {
  // Render the complete HTML file
  async renderInsightHTML(insights: InsightData): Promise<string> {
    // Escape tag-boundary characters so report data — chat summaries,
    // file/tool names, LLM output — cannot terminate the inline <script> that
    // carries it. Also escape U+2028/U+2029, which JSON.stringify emits raw but
    // which are line terminators to pre-ES2019 engines (embedded WebViews,
    // older Electron) and would throw SyntaxError. These are all valid JSON
    // escapes and parse back to the original characters, so the data reaching
    // the page is unchanged.
    const insightJson = escapeJsonTagCharacters(JSON.stringify(insights))
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Qwen Code Insights</title>
    <style>
      ${INSIGHT_CSS}
    </style>
  </head>
  <body>
    <div class="min-h-screen" id="container">
      <div class="mx-auto max-w-6xl px-6 py-10 md:py-12">
        <div id="react-root"></div>
      </div>
    </div>

    <!-- Application Data -->
    <script>
      window.INSIGHT_DATA = ${insightJson};
    </script>

    <!-- App Script -->
    <script>
      ${INSIGHT_JS}
    </script>
  </body>
</html>`;

    return html;
  }
}
