import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import videoConfig from './config/video.config';
import { envValidationSchema } from './config/env.validation';
import { bullRootOptions } from './queue/bull-root.options';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/**
 * Root module of the video worker.
 *
 * Deliberately narrower than `AppModule`: no HTTP layer, no auth, no mail, no
 * global guards. It carries only what processing needs — config, the database,
 * the queue connection and the processing module.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, storageConfig, queueConfig, videoConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync(bullRootOptions),
    // `autoLoadEntities` only discovers entities registered through a
    // `forFeature`. Video reaches Channel, and Channel declares a relation to
    // User, so the owning module of User has to be loaded here too or TypeORM
    // fails with "Entity metadata for Channel#user was not found".
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
