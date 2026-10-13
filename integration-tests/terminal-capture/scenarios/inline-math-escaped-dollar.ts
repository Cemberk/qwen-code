import type { ScenarioConfig } from '../scenario-runner.js';

const prompt = String.raw`Output only the following 7 lines of test text. Do not explain, do not number the lines, do not use a code block, and do not change any character. In particular, keep every dollar sign and backslash exactly as written:
$x^2$ is valid math
it costs $5 and $10
$5-$10
literal \$x$
formula $x + \$5$
literal then math: \$$x^2$
math then literal: $x^2\$$`;

export default {
  name: 'inline-math-escaped-dollar',
  spawn: ['node', 'dist/cli.js', '--yolo', '--model', 'qwen3.7-max-2026-06-08'],
  terminal: {
    title: 'qwen-code inline math',
    cwd: '../../..',
    cols: 120,
    rows: 32,
  },
  flow: [
    {
      type: prompt,
      capture: 'inline-math-escaped-dollar.png',
    },
    {
      sleep: 20000,
      capture: 'inline-math-escaped-dollar-settled.png',
    },
  ],
  gif: false,
} satisfies ScenarioConfig;
