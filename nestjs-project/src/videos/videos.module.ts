import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ConfigModule,
    ChannelsModule,
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  // TypeOrmModule is re-exported so the processing module can inject
  // Repository<Video>; VideosService is what the worker uses to move a video
  // through its status lifecycle; BullModule so the worker shares the same
  // queue registration.
  exports: [TypeOrmModule, VideosService, BullModule],
})
export class VideosModule {}
