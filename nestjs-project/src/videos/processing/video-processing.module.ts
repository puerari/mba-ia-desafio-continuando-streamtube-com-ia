import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MediaModule } from '../../media/media.module';
import { StorageModule } from '../../storage/storage.module';
import { VideosModule } from '../videos.module';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Imported only by `WorkerModule`. Keeping the `@Processor` out of the API's
 * module graph is what makes the container split real: if `AppModule` imported
 * this, the API would consume jobs too and FFmpeg would compete with request
 * handling for CPU.
 */
@Module({
  imports: [ConfigModule, VideosModule, StorageModule, MediaModule],
  providers: [VideoProcessingProcessor],
})
export class VideoProcessingModule {}
