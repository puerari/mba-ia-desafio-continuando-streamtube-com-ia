import type { SharedBullAsyncConfiguration } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

/**
 * Root BullMQ configuration, shared by the API (producer) and the video worker
 * (consumer) so the two can never drift apart on connection or retry policy.
 */
export const bullRootOptions: SharedBullAsyncConfiguration = {
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: {
      host: config.host,
      port: config.port,
    },
    defaultJobOptions: {
      attempts: config.attempts,
      backoff: { type: 'exponential', delay: config.backoffDelayMs },
      removeOnComplete: true,
      // Keep terminal failures in Redis so they stay inspectable.
      removeOnFail: false,
    },
  }),
};
