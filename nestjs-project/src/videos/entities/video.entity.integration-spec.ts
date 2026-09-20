import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateVideoSlug } from '../video-slug.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  const makeVideo = (overrides: Partial<Video> = {}): Video =>
    videoRepository.create({
      slug: generateVideoSlug(),
      channel_id: channel.id,
      title: 'A video',
      storage_key: `videos/${counter}/source.mp4`,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      ...overrides,
    });

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await userRepository.save(
      userRepository.create({
        email: `video_entity_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: `chan${counter}`,
        nickname: `chan${counter}`,
        user_id: user.id,
      }),
    );
  });

  it('defaults status to draft and auto-populates timestamps', async () => {
    const saved = await videoRepository.save(makeVideo());

    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('rejects a duplicate slug', async () => {
    const slug = generateVideoSlug();
    await videoRepository.save(makeVideo({ slug }));

    await expect(videoRepository.save(makeVideo({ slug }))).rejects.toThrow(
      QueryFailedError,
    );
  });

  it('rejects a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("slug","channel_id","title","status","storage_key","original_filename","content_type","size_bytes")
         VALUES ($1,$2,'t','published','k','f.mp4','video/mp4',1)`,
        [generateVideoSlug(), channel.id],
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('rejects a channel_id that does not exist', async () => {
    await expect(
      videoRepository.save(
        makeVideo({ channel_id: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('round-trips a 10GiB size_bytes as a number, not a string', async () => {
    const tenGiB = 10 * 1024 * 1024 * 1024;
    const saved = await videoRepository.save(makeVideo({ size_bytes: tenGiB }));

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(typeof reloaded.size_bytes).toBe('number');
    expect(reloaded.size_bytes).toBe(tenGiB);
  });

  it('round-trips a fractional duration as a number', async () => {
    const saved = await videoRepository.save(
      makeVideo({ duration_seconds: 12.345 }),
    );

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(typeof reloaded.duration_seconds).toBe('number');
    expect(reloaded.duration_seconds).toBeCloseTo(12.345, 3);
  });

  it('leaves the metadata columns null until processing fills them', async () => {
    const saved = await videoRepository.save(makeVideo());

    expect(saved.duration_seconds ?? null).toBeNull();
    expect(saved.width).toBeNull();
    expect(saved.height).toBeNull();
    expect(saved.video_codec).toBeNull();
    expect(saved.bitrate).toBeNull();
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.processing_error).toBeNull();
  });

  it('loads the owning channel and the channel loads its videos', async () => {
    const saved = await videoRepository.save(makeVideo());

    const withChannel = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });
    expect(withChannel.channel.id).toBe(channel.id);

    const withVideos = await channelRepository.findOneOrFail({
      where: { id: channel.id },
      relations: ['videos'],
    });
    expect(withVideos.videos.map((v) => v.id)).toContain(saved.id);
  });

  it('accepts every declared status value', async () => {
    for (const status of Object.values(VideoStatus)) {
      const saved = await videoRepository.save(makeVideo({ status }));
      expect(saved.status).toBe(status);
    }
  });
});
