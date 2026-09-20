import { NestFactory } from '@nestjs/core';
import { VideoProcessingProcessor } from './videos/processing/video-processing.processor';
import { WorkerModule } from './worker.module';
import { AppModule } from './app.module';

describe('WorkerModule', () => {
  it('boots as an application context and resolves the processor', async () => {
    // createApplicationContext, not createNestApplication: the worker serves
    // no HTTP and must not start a server.
    const context = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });

    expect(context.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );

    await context.close();
  }, 60000);

  it('keeps the processor out of the API module graph', async () => {
    // If AppModule ever imported VideoProcessingModule, the API container
    // would consume jobs too and FFmpeg would compete with request handling.
    const context = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    expect(() => context.get(VideoProcessingProcessor)).toThrow();

    await context.close();
  }, 60000);
});
