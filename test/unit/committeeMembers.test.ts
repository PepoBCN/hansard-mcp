/**
 * get_committee membership, against the shape committees-api.parliament.uk
 * actually returns (measured 25 Sep 2026). Before this, every name came back
 * null, roles came back empty and past members filled the first page.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';
import { __resetBreakers } from '../../src/core/breaker.js';
import { getCommittee, GetCommitteeInput } from '../../src/tools/getCommittee.js';

const ctx = { requestId: 'TEST' };

describe('get_committee membership', () => {
  const mock = new MockUpstream();
  beforeAll(async () => {
    setUpstream('committees', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });
  afterAll(async () => {
    await mock.stop();
    resetUpstreams();
  });
  beforeEach(async () => {
    mock.reset();
    await cache.clear();
    __resetBreakers();
  });

  const BODY = {
    id: 52,
    name: 'Environment, Food and Rural Affairs Committee',
    house: 'Commons',
    items: [
      {
        isLayMember: false,
        name: 'Rt Hon Alistair Carmichael MP',
        roles: [
          { startDate: '2024-09-09T00:00:00', endDate: null, role: { id: 1, name: 'Member' } },
          { startDate: '2024-09-09T00:00:00', endDate: null, role: { id: 2, name: 'Chair' } },
        ],
        memberInfo: { mnisId: 1442, displayAs: 'Mr Alistair Carmichael', party: 'Liberal Democrat', house: 'Commons' },
      },
      {
        isLayMember: true,
        name: 'A Lay Member',
        roles: [
          { endDate: '2025-01-01T00:00:00', role: { name: 'Chair' } },
          { endDate: null, role: { name: 'Member' } },
        ],
      },
    ],
  };

  it('returns names, current roles and asks only for current members', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = (await getCommittee(GetCommitteeInput.parse({ committee_id: 52 }) as never, ctx)) as {
      data: { house: string | null; members: Array<{ member_id: number | null; name: string | null; party: string | null; roles: string[] }> };
    };
    expect(mock.requests.join()).toContain('MembershipStatus=Current');
    expect(res.data.house).toBe('Commons');
    expect(res.data.members[0]).toMatchObject({
      member_id: 1442,
      name: 'Mr Alistair Carmichael',
      party: 'Liberal Democrat',
      roles: ['Member', 'Chair'],
    });
    expect(res.data.members[1]).toMatchObject({ member_id: null, name: 'A Lay Member', roles: ['Member'] });
  });
});
