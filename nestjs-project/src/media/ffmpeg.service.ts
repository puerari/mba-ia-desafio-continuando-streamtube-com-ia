import { spawn } from 'node:child_process';
import { Injectable, Logger } from '@nestjs/common';
import type { FfprobeOutput, VideoMetadata } from './media.types';

const FFPROBE_BIN = 'ffprobe';
const FFMPEG_BIN = 'ffmpeg';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class FfmpegError extends Error {
  constructor(
    public readonly binary: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(
      `${binary} exited with code ${exitCode ?? 'null'}: ${stderr.trim().slice(0, 500)}`,
    );
    this.name = 'FfmpegError';
  }
}

/**
 * The only place in the codebase that spawns a subprocess.
 *
 * Arguments are always passed as an array — never interpolated into a shell
 * string — so a file name can never be read as a shell token.
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  async probe(filePath: string): Promise<VideoMetadata> {
    const stdout = await this.run(FFPROBE_BIN, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );

    if (!videoStream) {
      throw new Error(`No video stream found in "${filePath}"`);
    }

    return {
      durationSeconds: this.readNumber(
        parsed.format?.duration ?? videoStream.duration,
      ),
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      videoCodec: videoStream.codec_name ?? 'unknown',
      bitrate: this.readOptionalNumber(
        parsed.format?.bit_rate ?? videoStream.bit_rate,
      ),
    };
  }

  /**
   * Writes a single JPEG frame.
   *
   * `-ss` comes BEFORE `-i` so ffmpeg seeks the input instead of decoding from
   * the start, and `scale=<width>:-2` derives an even height — JPEG encoders
   * reject odd dimensions, which is why this is `-2` and not `-1`.
   */
  async extractThumbnail(
    filePath: string,
    outputPath: string,
    atSeconds: number,
    width: number,
  ): Promise<void> {
    await this.run(FFMPEG_BIN, [
      '-ss',
      Math.max(0, atSeconds).toFixed(3),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-q:v',
      '2',
      '-y',
      outputPath,
    ]);
  }

  private readNumber(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private readOptionalNumber(value: string | undefined): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private run(
    binary: string,
    args: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (timedOut) {
          reject(
            new FfmpegError(
              binary,
              code,
              `timed out after ${timeoutMs}ms\n${stderr}`,
            ),
          );
          return;
        }

        if (code !== 0) {
          this.logger.warn(`${binary} failed with code ${code ?? 'null'}`);
          reject(new FfmpegError(binary, code, stderr));
          return;
        }

        resolve(stdout);
      });
    });
  }
}
