import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile with the S3_CLIENT factory and StorageService wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(S3_CLIENT)).toBeDefined();
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);

    await module.close();
  }, 15000);
});
