import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

const validateWithout = (keys: string[]) => {
  const env: Record<string, string> = { ...requiredEnv };
  for (const key of keys) delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video settings', () => {
  it('should reject a missing STORAGE_ACCESS_KEY', () => {
    const { error } = validateWithout(['STORAGE_ACCESS_KEY']);
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should reject a missing STORAGE_SECRET_KEY', () => {
    const { error } = validateWithout(['STORAGE_SECRET_KEY']);
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_KEY');
  });

  it('should apply the documented storage defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_BUCKET).toBe('streamtube');
    expect(value.STORAGE_FORCE_PATH_STYLE).toBe('true');
  });

  it('should apply the documented queue defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_QUEUE_ATTEMPTS).toBe(3);
    expect(value.VIDEO_QUEUE_LOCK_DURATION_MS).toBe(600000);
  });

  it('should default the upload limits to 10GiB with 64MiB parts', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024 * 1024);
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('should reject a part size below the 5MiB S3 minimum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject a thumbnail position outside the 0..1 range', () => {
    const { error } = validate({ VIDEO_THUMBNAIL_POSITION_RATIO: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_THUMBNAIL_POSITION_RATIO');
  });
});
