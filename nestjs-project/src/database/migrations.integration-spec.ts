import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1789934355956 } from './migrations/1789934355956-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

/**
 * Enum types are schema objects of their own: `DROP TABLE ... CASCADE` leaves
 * them behind, so a second run of this suite would hit
 * `type "..._enum" already exists` on the very first CREATE TYPE. Dropping
 * them here is what makes the suite repeatable.
 */
const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_status_enum',
];

const MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideos1789934355956,
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      { synchronize: false, migrations: MIGRATIONS },
    );

    await dataSource.initialize();

    try {
      for (const table of [...MANAGED_TABLES, 'migrations']) {
        await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
      for (const type of MANAGED_ENUM_TYPES) {
        await dataSource.query(
          `DROP TYPE IF EXISTS "public"."${type}" CASCADE`,
        );
      }
    } catch (error) {
      // Without this the DataSource stays open on a setup failure and Jest
      // hangs on the dangling handle instead of reporting the real error.
      await dataSource.destroy();
      throw error;
    }
  });

  afterAll(async () => {
    // The revert test leaves the videos table missing; re-apply so the shared
    // database is fully migrated for the suites that run after this one.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(MIGRATIONS.length);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([...MANAGED_TABLES].sort());
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      ['videos'],
    );
    expect(tables).toHaveLength(0);

    // The enum type is dropped by the migration's down() as well — leaving it
    // behind is what made this suite non-repeatable before.
    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = $1`,
      ['videos_status_enum'],
    );
    expect(types).toHaveLength(0);
  });
});
