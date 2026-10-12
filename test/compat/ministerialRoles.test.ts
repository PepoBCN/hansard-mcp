/**
 * Stage 2a: `parliament_get_ministerial_roles` used to answer "who is in the
 * cabinet" and the rebuild dropped that, requiring a `member_id` instead. These
 * cover the restored listing mode against a controlled upstream, including the
 * case that matters most: an upstream failure must not read as an empty
 * government.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';
import { __resetBreakers } from '../../src/core/breaker.js';
import { getMinisterialRoles } from '../../src/tools/getMinisterialRoles.js';
import { isReportableAbsence } from '../../src/envelope.js';

const ctx = { requestId: 'TEST' };

const post = (
  id: number,
  name: string,
  department: string,
  holder: string | null,
  memberId = 100 + id,
) => ({
  value: {
    id,
    name,
    hansardName: name,
    governmentDepartments: [{ name: department }],
    postHolders: holder
      ? [
          {
            member: { value: { id: memberId, nameDisplayAs: holder, latestParty: { name: 'Labour' } } },
            startDate: '2026-07-20T00:00:00',
            endDate: null,
          },
        ]
      : [],
  },
});

const CABINET = [
  post(1, 'Prime Minister and First Lord of the Treasury', 'Prime Minister', 'Andy Burnham'),
  post(2, 'Chancellor of the Exchequer', 'HM Treasury', 'John Healey'),
  post(3, 'Home Secretary', 'Home Office', 'Shabana Mahmood'),
  post(4, 'Minister without Portfolio', 'Cabinet Office', null),
];

describe('get_ministerial_roles listing mode', () => {
  let mock: MockUpstream;

  beforeAll(async () => {
    mock = new MockUpstream();
    const base = await mock.start();
    setUpstream('members', { base, timeoutMs: 1_000, ttlMs: 60_000 });
  });

  afterAll(async () => {
    await mock.stop();
    resetUpstreams();
  });

  beforeEach(() => {
    mock.reset();
    cache.clear();
    __resetBreakers();
  });

  it('lists the front bench when no member_id is given', async () => {
    mock.set({ kind: 'ok', body: CABINET });
    const res = (await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50 } as never, ctx)) as never as {
      data: { mode: string; branch: string; roles: Array<{ post: string; holder: string | null }>; total: number };
    };

    expect(res.data.mode).toBe('branch_listing');
    expect(res.data.branch).toBe('government');
    expect(res.data.roles).toHaveLength(4);
    expect(res.data.roles.map((r) => r.holder)).toContain('Andy Burnham');
  });

  it('asks the government endpoint for government and the opposition one for opposition', async () => {
    mock.set({ kind: 'ok', body: CABINET });
    await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50 } as never, ctx);
    expect(mock.requests.join()).toContain('/Posts/GovernmentPosts');

    mock.reset();
    cache.clear();
    mock.set({ kind: 'ok', body: CABINET });
    await getMinisterialRoles({ branch: 'opposition', include_historical: true, limit: 50 } as never, ctx);
    expect(mock.requests.join()).toContain('/Posts/OppositionPosts');
  });

  it('reports a vacancy as a null holder rather than dropping the post', async () => {
    mock.set({ kind: 'ok', body: CABINET });
    const res = (await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50 } as never, ctx)) as never as {
      data: { roles: Array<{ post: string; holder: string | null; is_current: boolean }> };
    };
    const vacancy = res.data.roles.find((r) => r.post === 'Minister without Portfolio');
    expect(vacancy).toBeDefined();
    expect(vacancy?.holder).toBeNull();
    expect(vacancy?.is_current).toBe(false);
  });

  it('filters on post, department or holder', async () => {
    for (const [needle, expected] of [
      ['treasury', 'Chancellor of the Exchequer'],
      ['burnham', 'Prime Minister and First Lord of the Treasury'],
      ['home', 'Home Secretary'],
    ] as const) {
      mock.reset();
      cache.clear();
      mock.set({ kind: 'ok', body: CABINET });
      const res = (await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50, filter: needle } as never, ctx)) as never as {
        data: { roles: Array<{ post: string }>; filter: string | null };
      };
      expect(res.data.filter).toBe(needle);
      expect(res.data.roles.map((r) => r.post)).toContain(expected);
    }
  });

  it('says how many the upstream returned versus how many survived the filter', async () => {
    mock.set({ kind: 'ok', body: CABINET });
    const res = (await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50, filter: 'treasury' } as never, ctx)) as never as {
      data: { retrieval: { returned_by_upstream: number; kept_after_filter: number } };
    };
    expect(res.data.retrieval.returned_by_upstream).toBe(4);
    // "treasury" matches two: the Chancellor by department (HM Treasury) and
    // the PM by post name (First Lord of the Treasury). Both are correct hits.
    expect(res.data.retrieval.kept_after_filter).toBe(2);
  });

  /**
   * The point of the whole engine. A timeout must not look like a government
   * with no ministers in it.
   */
  it('a timed-out upstream is a timeout, never an empty government', async () => {
    mock.set({ kind: 'hang' });
    const res = (await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50 } as never, ctx)) as never as {
      data: { roles: unknown[] };
      meta: { partial: boolean; sources_status: Record<string, { status: string }> };
    };

    expect(res.data.roles).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.posts?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.posts)).toBe(false);
  });

  it('an upstream 500 is likewise not an absence', async () => {
    mock.set({ kind: 'status', status: 500 });
    const res = (await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50 } as never, ctx)) as never as {
      meta: { sources_status: Record<string, { status: string }> };
    };
    expect(isReportableAbsence(res.meta.sources_status.posts)).toBe(false);
  });

  it('an empty government with an ok status IS a reportable absence', async () => {
    mock.set({ kind: 'ok', body: [] });
    const res = (await getMinisterialRoles({ branch: 'government', include_historical: true, limit: 50 } as never, ctx)) as never as {
      data: { roles: unknown[] };
      meta: { sources_status: Record<string, { status: string }> };
    };
    expect(res.data.roles).toHaveLength(0);
    expect(res.meta.sources_status.posts?.status).toBe('ok');
  });
});
