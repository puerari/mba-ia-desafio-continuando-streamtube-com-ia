import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

/**
 * The shape the `pg` driver attaches to a QueryFailedError. TypeORM types the
 * driver error as `any`, so narrowing it here keeps the `any` out of callers.
 */
interface PgDriverError {
  code?: unknown;
  detail?: unknown;
}

function asPgDriverError(error: unknown): PgDriverError | null {
  if (!(error instanceof QueryFailedError)) return null;
  return error as unknown as PgDriverError;
}

/**
 * True when the error is a Postgres unique-constraint violation whose detail
 * names the given column — e.g. `Key (slug)=(abc) already exists.`
 */
export function isUniqueViolationOnColumn(
  error: unknown,
  column: string,
): boolean {
  const driverError = asPgDriverError(error);
  if (!driverError) return false;

  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(column)
  );
}
