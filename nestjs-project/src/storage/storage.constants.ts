/**
 * DI token for the configured S3 client. Injected as a token rather than the
 * class so tests can substitute a client pointed at a different endpoint
 * without touching StorageService.
 */
export const S3_CLIENT = 'S3_CLIENT';
