import { Test } from '@nestjs/testing';
import { FfmpegService } from './ffmpeg.service';
import { MediaModule } from './media.module';

describe('MediaModule', () => {
  it('should compile and export FfmpegService', async () => {
    const module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();

    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);

    await module.close();
  }, 15000);
});
