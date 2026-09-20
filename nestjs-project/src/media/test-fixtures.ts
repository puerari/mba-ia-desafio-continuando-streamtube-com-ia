import { spawn } from 'node:child_process';

/**
 * Synthesizes a small playable clip with ffmpeg's own test source, so no
 * binary asset has to be committed to the repository.
 *
 * `-pix_fmt yuv420p` keeps the output readable by the same decoders a real
 * upload would go through.
 */
export function createFixtureClip(
  outputPath: string,
  {
    durationSeconds = 2,
    width = 320,
    height = 240,
    frameRate = 15,
  }: {
    durationSeconds?: number;
    width?: number;
    height?: number;
    frameRate?: number;
  } = {},
): Promise<void> {
  const args = [
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=${frameRate}`,
    '-pix_fmt',
    'yuv420p',
    '-y',
    outputPath,
  ];

  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`fixture generation failed (${code}): ${stderr}`));
      }
    });
  });
}
