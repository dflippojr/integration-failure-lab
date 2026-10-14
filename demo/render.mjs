// npm run demo:render: capture the current UI, then render the HyperFrames scenes in demo/scenes/ to
// demo/out/lab-demo.mp4 and a poster PNG. HyperFrames, FFmpeg and GSAP are pinned in demo/package.json,
// installed on first use, and never reach dist/. Needs Node 22+ and Playwright's Chromium (npx playwright install chromium).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const demo = import.meta.dirname;
const scenes = join(demo, 'scenes');
const out = join(demo, 'out');
const video = join(out, 'lab-demo.mp4');
const poster = join(out, 'lab-demo-poster.png');
const POSTER_AT = 22; // seconds: the wrong record, ringed
const MAX_BYTES = 5 * 1024 * 1024;

const step = (label, command, args, options = {}) => {
  const started = performance.now();
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
  console.log(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
};

const started = performance.now();
if (!existsSync(join(demo, 'node_modules', 'hyperframes', 'package.json'))) {
  step('Install demo tools', 'npm', ['ci', '--no-fund', '--no-audit'], { cwd: demo, shell: true });
}
const require = createRequire(join(demo, 'package.json'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const hyperframes = join(demo, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
const env = {
  ...process.env,
  HYPERFRAMES_FFMPEG_PATH: ffmpeg, HYPERFRAMES_FFPROBE_PATH: ffprobe,
  HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1',
};

step('Capture', process.execPath, [join(demo, 'capture.mjs')]);
mkdirSync(join(scenes, 'vendor'), { recursive: true });
copyFileSync(require.resolve('gsap/dist/gsap.min.js'), join(scenes, 'vendor', 'gsap.min.js'));
mkdirSync(out, { recursive: true });
// Two workers and software GL keep the render light on a shared machine and the frames repeatable.
step('Render', process.execPath, [hyperframes, 'render', scenes, '--output', video, '--fps', '30', '--crf', '30',
  '--workers', '2', '--no-browser-gpu', '--strict', '--quiet'], { env });
step('Poster', ffmpeg, ['-v', 'error', '-y', '-ss', String(POSTER_AT), '-i', video, '-frames:v', '1', poster]);

const bytes = statSync(video).size;
console.log(`${video}: ${(bytes / 1024 / 1024).toFixed(2)} MB; ${poster}: ${(statSync(poster).size / 1024).toFixed(0)} KB`);
console.log(`Total: ${((performance.now() - started) / 1000).toFixed(1)} s`);
if (bytes > MAX_BYTES) throw new Error(`The clip is over 5 MB (${bytes} bytes); raise --crf`);
