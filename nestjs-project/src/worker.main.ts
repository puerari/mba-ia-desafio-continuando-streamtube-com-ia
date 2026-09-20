// Must come before any module import: the @Processor decorator in
// video-processing.processor.ts reads its worker options at class-definition
// time, and without .env loaded it would silently fall back to defaults.
import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // An application context gives the DI container without an HTTP server —
  // the worker serves no requests.
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Lets BullMQ close its Redis connection and finish the in-flight job on
  // SIGTERM instead of being killed after the stop timeout.
  app.enableShutdownHooks();

  new Logger('VideoWorker').log(
    `Video worker started — consuming queue "${VIDEO_PROCESSING_QUEUE}"`,
  );
}

void bootstrap();
