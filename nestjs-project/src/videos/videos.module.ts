import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  // TypeOrmModule is re-exported so the processing module can inject
  // Repository<Video> without registering the entity a second time.
  exports: [TypeOrmModule],
})
export class VideosModule {}
