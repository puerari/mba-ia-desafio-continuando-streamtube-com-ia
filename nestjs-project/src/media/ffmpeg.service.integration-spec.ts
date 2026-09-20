import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegError, FfmpegService } from './ffmpeg.service';
import { createFixtureClip } from './test-fixtures';

/**
 * Runs the real binaries. A mocked child_process would prove nothing here —
 * the failures this adapter is exposed to are wrong argument order, odd
 * dimensions rejected by the JPEG encoder and unreadable containers.
 */
describe('FfmpegService (integration)', () => {
  const service = new FfmpegService();
  let workDir: string;
  let clipPath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
    clipPath = join(workDir, 'fixture.mp4');
    await createFixtureClip(clipPath);
  }, 60_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('probe', () => {
    it('reads duration, dimensions and codec from a real clip', async () => {
      const metadata = await service.probe(clipPath);

      expect(metadata.durationSeconds).toBeGreaterThan(1.8);
      expect(metadata.durationSeconds).toBeLessThan(2.2);
      expect(metadata.width).toBe(320);
      expect(metadata.height).toBe(240);
      expect(metadata.videoCodec).toBeTruthy();
      expect(metadata.videoCodec).not.toBe('unknown');
    }, 30_000);

    it('reports a bitrate for a real container', async () => {
      const metadata = await service.probe(clipPath);
      expect(metadata.bitrate).toBeGreaterThan(0);
    }, 30_000);

    it('rejects a file that is not media, carrying the process stderr', async () => {
      const notMedia = join(workDir, 'notes.txt');
      await writeFile(notMedia, 'this is not a video');

      await expect(service.probe(notMedia)).rejects.toBeInstanceOf(FfmpegError);
      await expect(service.probe(notMedia)).rejects.toThrow(/ffprobe/);
    }, 30_000);

    it('rejects a missing file instead of returning empty metadata', async () => {
      await expect(
        service.probe(join(workDir, 'does-not-exist.mp4')),
      ).rejects.toThrow();
    }, 30_000);

    it('rejects an audio-only file with a clear message', async () => {
      const audioOnly = join(workDir, 'audio.mp3');
      await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', [
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-y',
          audioOnly,
        ]);
        child.on('error', reject);
        child.on('close', () => resolve());
      });

      await expect(service.probe(audioOnly)).rejects.toThrow(/No video stream/);
    }, 30_000);
  });

  describe('extractThumbnail', () => {
    it('writes a non-empty JPEG at the requested width', async () => {
      const thumbnail = join(workDir, 'thumb.jpg');

      await service.extractThumbnail(clipPath, thumbnail, 0.2, 160);

      const stats = await stat(thumbnail);
      expect(stats.size).toBeGreaterThan(0);

      const probed = await service.probe(thumbnail);
      expect(probed.width).toBe(160);
      // scale=<w>:-2 keeps the aspect ratio and forces an even height
      expect(probed.height).toBe(120);
      expect(probed.height % 2).toBe(0);
    }, 30_000);

    it('derives an even height from an odd target ratio', async () => {
      const thumbnail = join(workDir, 'thumb-odd.jpg');

      await service.extractThumbnail(clipPath, thumbnail, 0.2, 150);

      const probed = await service.probe(thumbnail);
      expect(probed.height % 2).toBe(0);
    }, 30_000);

    it('overwrites an existing output without prompting', async () => {
      const thumbnail = join(workDir, 'thumb-twice.jpg');

      await service.extractThumbnail(clipPath, thumbnail, 0.1, 160);
      // Without -y ffmpeg would block on an interactive overwrite prompt and
      // the second call would hang until the timeout.
      await service.extractThumbnail(clipPath, thumbnail, 0.5, 160);

      const stats = await stat(thumbnail);
      expect(stats.size).toBeGreaterThan(0);
    }, 30_000);

    it('rejects when the source cannot be decoded', async () => {
      const notMedia = join(workDir, 'broken.mp4');
      await writeFile(notMedia, 'not really an mp4');

      await expect(
        service.extractThumbnail(notMedia, join(workDir, 'x.jpg'), 0, 160),
      ).rejects.toBeInstanceOf(FfmpegError);
    }, 30_000);
  });
});
