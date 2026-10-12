/**
 * Stage 3d: five parameters the 0.2.0 surface took that the rebuild dropped -
 * search_hansard's `member_id` and `section`, member_voting_history's `topic`,
 * member_interests' `category_number`, get_division's `include_rebellions` and
 * get_committee's `include_evidence`.
 *
 * What these guard is the same thing the rest of the compat suite guards: not
 * that a parameter is accepted, but that accepting it means something. Each one
 * is checked three ways - it is advertised, it genuinely changes the answer (or
 * says in `data` that it could not be applied and why), and a degraded upstream
 * still comes back as a status rather than as an absence.
 *
 * Two of them are worth the extra words. `include_rebellions` must never return
 * an empty rebel list when it could not read the parties, because that reads as
 * "nobody rebelled". `category_number` must never return the unfiltered register
 * when the number could not be resolved, because that reads as one category.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';
import { __resetBreakers } from '../../src/core/breaker.js';
import { isReportableAbsence } from '../../src/envelope.js';
import { searchHansard, SearchHansardInput } from '../../src/tools/searchHansard.js';
import { memberVotingHistory, MemberVotingHistoryInput } from '../../src/tools/memberVotingHistory.js';
import { memberInterests, MemberInterestsInput } from '../../src/tools/memberInterests.js';
import { getDivision, GetDivisionInput } from '../../src/tools/getDivision.js';
import { getCommittee, GetCommitteeInput } from '../../src/tools/getCommittee.js';
import { tools } from '../../src/tools/index.js';

const ctx = { requestId: 'TEST' };

type Envelope<D> = { data: D; meta: { partial: boolean; sources_status: Record<string, { status: string }> } };

const call = async <D,>(
  handler: (input: never, c: typeof ctx) => Promise<unknown>,
  schema: { parse: (v: unknown) => unknown },
  args: Record<string, unknown>,
): Promise<Envelope<D>> => (await handler(schema.parse(args) as never, ctx)) as never as Envelope<D>;

/** The advertised schema is what a legacy caller is validated against. */
const advertised = (name: string) =>
  Object.keys(
    (tools.find((t) => t.name === name)!.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
  );

describe('the five restored parameters are advertised', () => {
  const cases: Array<[string, string]> = [
    ['parliament_search_hansard', 'member_id'],
    ['parliament_search_hansard', 'section'],
    ['parliament_member_voting_history', 'topic'],
    ['parliament_member_interests', 'category_number'],
    ['parliament_get_division', 'include_rebellions'],
    ['parliament_get_committee', 'include_evidence'],
  ];

  for (const [tool, param] of cases) {
    it(`${tool} advertises ${param}`, () => {
      expect(advertised(tool)).toContain(param);
    });
  }
});

describe('search_hansard restricts to one member, in the index that honours it', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('hansard', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
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

  const CONTRIBUTIONS = {
    TotalResultCount: 2,
    Results: [
      {
        MemberId: 172,
        MemberName: 'Ms Diane Abbott',
        ContributionExtId: 'C1',
        ContributionText: 'On climate change, the House should note...',
        DebateSection: 'Climate Change Targets',
        DebateSectionExtId: 'A',
        Section: 'Commons Chamber',
        House: 'Commons',
        SittingDate: '2026-04-14T00:00:00',
      },
      // A row for somebody else, as an upstream that stopped filtering would send.
      {
        MemberId: 4514,
        MemberName: 'Sir Keir Starmer',
        ContributionExtId: 'C2',
        ContributionText: 'Climate change is...',
        DebateSection: 'Climate Change Adaptation',
        DebateSectionExtId: 'B',
        Section: 'Commons Chamber',
        House: 'Commons',
        SittingDate: '2026-04-15T00:00:00',
      },
    ],
  };

  it('asks the contributions endpoint, not the debate search, and sends the member id', async () => {
    mock.set({ kind: 'ok', body: CONTRIBUTIONS });
    await call(searchHansard, SearchHansardInput, { query: 'climate change', member_id: 172 });

    expect(mock.requests.join()).toContain('/search/contributions/Spoken.json');
    expect(mock.requests.join()).toContain('queryParameters.memberId=172');
    expect(mock.requests.join()).not.toContain('/search/debates.json');
  });

  it('returns that member\'s contributions and drops a row belonging to anybody else', async () => {
    mock.set({ kind: 'ok', body: CONTRIBUTIONS });
    const res = await call<{
      member_id: number | null;
      member_filter_applied: string;
      search_scope: string;
      member_filter_note: string;
      retrieval: { returned_by_upstream: number; kept_after_member_check: number };
      debates: Array<{ member_id: number | null; contribution: string | null; section: string | null }>;
    }>(searchHansard, SearchHansardInput, { query: 'climate change', member_id: 172 });

    expect(res.data.member_id).toBe(172);
    expect(res.data.member_filter_applied).toBe('upstream');
    expect(res.data.search_scope).toBe('member_spoken_contributions');
    // The note has to say what the spoken index cannot answer for.
    expect(res.data.member_filter_note).toMatch(/written/i);
    expect(res.data.retrieval.returned_by_upstream).toBe(2);
    expect(res.data.retrieval.kept_after_member_check).toBe(1);
    expect(res.data.debates).toHaveLength(1);
    expect(res.data.debates[0].member_id).toBe(172);
    expect(res.data.debates[0].contribution).toMatch(/On climate change/);
  });

  it('without a member id nothing changes: the debate search, and no member claim', async () => {
    mock.set({
      kind: 'ok',
      body: {
        TotalResultCount: 1,
        Results: [
          { DebateSectionExtId: 'A', Title: 'Climate Change Targets', House: 'Commons', SittingDate: '2026-04-14T00:00:00', DebateSection: 'Commons Chamber' },
        ],
      },
    });
    const res = await call<{ member_id: number | null; member_filter_applied: string; search_scope: string }>(
      searchHansard,
      SearchHansardInput,
      { query: 'climate change' },
    );

    expect(mock.requests.join()).toContain('/search/debates.json');
    expect(res.data.member_id).toBeNull();
    expect(res.data.member_filter_applied).toBe('none');
    expect(res.data.search_scope).toBe('debate_titles');
  });

  it('a timed-out contributions search is a timeout, not a member who never spoke', async () => {
    mock.set({ kind: 'hang' });
    const res = await call<{ debates: unknown[]; member_filter_applied: string }>(
      searchHansard,
      SearchHansardInput,
      { query: 'climate change', member_id: 172 },
    );

    expect(res.data.debates).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.debates?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.debates)).toBe(false);
  });
});

describe('search_hansard narrows to a Hansard section, and says where that happened', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('hansard', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
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

  const DEBATES = {
    TotalResultCount: 3,
    Results: [
      { DebateSectionExtId: 'A', Title: 'Climate Change Targets', House: 'Commons', SittingDate: '2026-04-14T00:00:00', DebateSection: 'Commons Chamber' },
      { DebateSectionExtId: 'B', Title: 'Climate Change Adaptation', House: 'Commons', SittingDate: '2026-04-15T00:00:00', DebateSection: 'Westminster Hall' },
      { DebateSectionExtId: 'C', Title: 'Climate Change Levy', House: 'Lords', SittingDate: '2026-04-16T00:00:00', DebateSection: 'Grand Committee' },
    ],
  };

  it('keeps only the requested section and reports the filter as local', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    const res = await call<{
      section: string | null;
      section_filter_applied: string;
      section_filter_note: string;
      sections_in_page: string[];
      retrieval: { returned_by_upstream: number; kept_after_section_filter: number };
      debates: Array<{ debate_ext_id: string; section: string | null }>;
    }>(searchHansard, SearchHansardInput, { query: 'climate change', section: 'Westminster Hall' });

    expect(res.data.section).toBe('Westminster Hall');
    expect(res.data.section_filter_applied).toBe('server_side');
    expect(res.data.section_filter_note).toMatch(/does not accept a section/);
    expect(res.data.debates.map((d) => d.debate_ext_id)).toEqual(['B']);
    expect(res.data.retrieval).toEqual({ returned_by_upstream: 3, kept_after_section_filter: 1 });
    // What the page held, so an empty result can be read for what it is.
    expect(res.data.sections_in_page.sort()).toEqual(['Commons Chamber', 'Grand Committee', 'Westminster Hall']);
  });

  it('does not send the section upstream, because neither endpoint accepts one', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    await call(searchHansard, SearchHansardInput, { query: 'climate change', section: 'Westminster Hall' });
    expect(mock.requests.join().toLowerCase()).not.toContain('section=');
  });

  it('reports no section filter at all when none was asked for', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    const res = await call<{ section: string | null; section_filter_applied: string; debates: unknown[] }>(
      searchHansard,
      SearchHansardInput,
      { query: 'climate change' },
    );
    expect(res.data.section).toBeNull();
    expect(res.data.section_filter_applied).toBe('none');
    expect(res.data.debates).toHaveLength(3);
  });

  it('a 500 with a section asked for is an error, not an empty section', async () => {
    mock.set({ kind: 'status', status: 500 });
    const res = await call<{ debates: unknown[]; section_filter_applied: string }>(searchHansard, SearchHansardInput, {
      query: 'climate change',
      section: 'Westminster Hall',
    });

    expect(res.data.debates).toHaveLength(0);
    expect(res.meta.sources_status.debates?.status).toBe('upstream_error');
    expect(isReportableAbsence(res.meta.sources_status.debates)).toBe(false);
  });
});

describe('member_voting_history filters by topic, in the votes API itself', () => {
  const commons = new MockUpstream();
  const lords = new MockUpstream();

  beforeAll(async () => {
    setUpstream('commonsVotes', { base: await commons.start(), timeoutMs: 1_000, ttlMs: 60_000 });
    setUpstream('lordsVotes', { base: await lords.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });
  afterAll(async () => {
    await commons.stop();
    await lords.stop();
    resetUpstreams();
  });
  beforeEach(async () => {
    commons.reset();
    lords.reset();
    await cache.clear();
    __resetBreakers();
  });

  const vote = (id: number, title: string) => ({
    PublishedDivision: { DivisionId: id, Title: title, Date: '2026-04-14T00:00:00', AyeCount: 1, NoCount: 1 },
    MemberVotedAye: true,
  });
  // The third is off topic on purpose: it stands in for an upstream that has
  // quietly stopped honouring the parameter, as the written-questions one does.
  const VOTES = [vote(1, 'Climate Change Bill: Third Reading'), vote(2, 'Climate Change Levy'), vote(3, 'Housing Bill')];

  it('sends the topic upstream and reports the filter as upstream', async () => {
    commons.set({ kind: 'ok', body: VOTES });
    const res = await call<{ topic: string | null; topic_filtered: boolean; topic_filter_applied: string }>(
      memberVotingHistory,
      MemberVotingHistoryInput,
      { member_id: 4514, topic: 'climate' },
    );

    expect(commons.requests.join()).toContain('queryParameters.searchTerm=climate');
    expect(res.data.topic).toBe('climate');
    expect(res.data.topic_filtered).toBe(true);
    expect(res.data.topic_filter_applied).toBe('upstream');
  });

  it('re-checks the page, so an upstream that stopped filtering cannot slip through', async () => {
    commons.set({ kind: 'ok', body: VOTES });
    const res = await call<{
      votes: Array<{ division_id: number }>;
      retrieval: { returned_by_upstream: number; kept_after_topic_check: number; titles_unverifiable: number };
    }>(memberVotingHistory, MemberVotingHistoryInput, { member_id: 4514, topic: 'climate' });

    expect(res.data.votes.map((v) => v.division_id)).toEqual([1, 2]);
    expect(res.data.retrieval).toEqual({ returned_by_upstream: 3, kept_after_topic_check: 2, titles_unverifiable: 0 });
  });

  it('the Lords record takes the topic too, on its own parameter name', async () => {
    lords.set({
      kind: 'ok',
      body: [
        { memberWasContent: true, memberWasTeller: false, publishedDivision: { divisionId: 9, date: '2026-04-14T00:00:00', title: 'Climate Change Bill' } },
        { memberWasContent: false, memberWasTeller: false, publishedDivision: { divisionId: 10, date: '2026-04-15T00:00:00', title: 'Housing Bill' } },
      ],
    });
    const res = await call<{ votes: Array<{ division_id: number; title: string; voted: string }> }>(
      memberVotingHistory,
      MemberVotingHistoryInput,
      { member_id: 3898, house: 'Lords', topic: 'climate' },
    );

    expect(lords.requests.join()).toContain('SearchTerm=climate');
    expect(res.data.votes).toHaveLength(1);
    expect(res.data.votes[0]).toMatchObject({ division_id: 9, title: 'Climate Change Bill', voted: 'Content' });
  });

  it('reports no topic filter, and no search term, when none was given', async () => {
    commons.set({ kind: 'ok', body: VOTES });
    const res = await call<{ topic: string | null; topic_filtered: boolean; votes: unknown[] }>(
      memberVotingHistory,
      MemberVotingHistoryInput,
      { member_id: 4514 },
    );

    expect(commons.requests.join()).not.toContain('searchTerm');
    expect(res.data.topic).toBeNull();
    expect(res.data.topic_filtered).toBe(false);
    expect(res.data.votes).toHaveLength(3);
  });

  it('a dead connection is a dead connection, not a member who never voted on the topic', async () => {
    commons.set({ kind: 'reset' });
    const res = await call<{ votes: unknown[]; topic_filter_applied: string }>(
      memberVotingHistory,
      MemberVotingHistoryInput,
      { member_id: 4514, topic: 'climate' },
    );

    expect(res.data.votes).toHaveLength(0);
    expect(res.data.topic_filter_applied).toBe('upstream');
    expect(res.meta.sources_status.commonsVotes?.status).not.toBe('ok');
    expect(isReportableAbsence(res.meta.sources_status.commonsVotes)).toBe(false);
  });
});

describe('member_interests restricts to one register category', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('interests', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
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

  /**
   * One body has to answer both calls, because the tool resolves the category
   * number against /Categories before it asks /Interests for the register. Each
   * row is therefore readable as a category (id, number, name) and as a register
   * entry (summary, category, member) at once.
   */
  const entry = (categoryId: number, number: string, name: string, summary: string) => ({
    id: categoryId,
    number,
    name,
    type: 'Commons',
    summary,
    registrationDate: '2026-04-02',
    category: { id: categoryId, number, name },
    member: { id: 4514, nameDisplayAs: 'A Member' },
  });

  const BODY = {
    totalResults: 3,
    items: [
      entry(3, '2', 'Donations and other support', 'Donation from a trust'),
      entry(4, '3', 'Gifts, benefits and hospitality', 'A ticket'),
      entry(12, '1', 'Employment and earnings', 'Salary from a second job'),
    ],
  };

  it('resolves the number to a category id and sends that id upstream', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = await call<{ category_number: string | null; category_filter_applied: string; category_name: string | null }>(
      memberInterests,
      MemberInterestsInput,
      { member_id: 4514, category_number: '2' },
    );

    expect(mock.requests.join()).toContain('/Categories');
    expect(mock.requests.join()).toContain('CategoryId=3');
    expect(res.data.category_number).toBe('2');
    expect(res.data.category_filter_applied).toBe('upstream');
    expect(res.data.category_name).toBe('Donations and other support');
  });

  it('re-checks the page, so only that category survives', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = await call<{
      interests: Array<{ id: number; category_number: string | null }>;
      retrieval: { returned_by_upstream: number; kept_after_category_check: number };
    }>(memberInterests, MemberInterestsInput, { member_id: 4514, category_number: '2' });

    expect(res.data.interests.map((i) => i.category_number)).toEqual(['2']);
    expect(res.data.retrieval).toEqual({ returned_by_upstream: 3, kept_after_category_check: 1 });
  });

  /** The whole register returned under one category's name would be a lie. */
  it('returns nothing, and says why, for a number the register does not have', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = await call<{
      category_filter_applied: string;
      category_filter_note: string;
      interests: unknown[];
    }>(memberInterests, MemberInterestsInput, { member_id: 4514, category_number: '99' });

    expect(res.data.category_filter_applied).toBe('not_applied');
    expect(res.data.interests).toHaveLength(0);
    expect(res.data.category_filter_note).toMatch(/no category numbered "99"/i);
    expect(res.data.category_filter_note).toMatch(/NOT evidence/);
    // And it names the numbers that do exist, so the caller can retry.
    expect(res.data.category_filter_note).toContain('1');
    expect(mock.requests.join()).not.toContain('CategoryId=');
  });

  it('leaves the register alone when no category was asked for', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = await call<{ category_filter_applied: string; interests: unknown[] }>(
      memberInterests,
      MemberInterestsInput,
      { member_id: 4514 },
    );

    expect(mock.requests.join()).not.toContain('/Categories');
    expect(res.data.category_filter_applied).toBe('none');
    expect(res.data.interests).toHaveLength(3);
  });

  it('a timed-out category index is a timeout, not a member with nothing in that category', async () => {
    mock.set({ kind: 'hang' });
    const res = await call<{ interests: unknown[] }>(memberInterests, MemberInterestsInput, {
      member_id: 4514,
      category_number: '2',
    });

    expect(res.data.interests).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.interests?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.interests)).toBe(false);
  });
});

describe('get_division identifies members who voted against their own party', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('commonsVotes', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
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

  const DIVISION = {
    DivisionId: 1745,
    Title: 'Climate Change Bill: Third Reading',
    Date: '2026-04-14T00:00:00',
    AyeCount: 3,
    NoCount: 2,
    Ayes: [
      { MemberId: 1, Name: 'Labour One', Party: 'Labour' },
      { MemberId: 2, Name: 'Labour Two', Party: 'Labour' },
      { MemberId: 3, Name: 'Conservative One', Party: 'Conservative' },
    ],
    Noes: [
      { MemberId: 4, Name: 'Labour Rebel', Party: 'Labour' },
      { MemberId: 5, Name: 'Conservative Two', Party: 'Conservative' },
    ],
  };

  it('names the rebel and gives the party direction they went against', async () => {
    mock.set({ kind: 'ok', body: DIVISION });
    const res = await call<{
      include_rebellions: boolean;
      rebellions: {
        rebel_count: number;
        rebels: Array<{ member_id: number | null; name: string | null; party: string | null; voted: string; party_majority: string | null }>;
        party_majority_direction: Array<{ party: string; ayes: number; noes: number; majority_direction: string | null }>;
        parties_with_no_majority: string[];
        basis: string;
      } | null;
    }>(getDivision, GetDivisionInput, { division_id: 1745, include_rebellions: true });

    expect(res.data.include_rebellions).toBe(true);
    expect(res.data.rebellions?.rebel_count).toBe(1);
    expect(res.data.rebellions?.rebels[0]).toMatchObject({
      member_id: 4,
      name: 'Labour Rebel',
      party: 'Labour',
      voted: 'No',
      party_majority: 'Aye',
    });
    // The Conservatives split one apiece, so they have no majority to rebel
    // against and nobody is called a rebel on the strength of a tie.
    expect(res.data.rebellions?.parties_with_no_majority).toEqual(['Conservative']);
    expect(res.data.rebellions?.party_majority_direction).toContainEqual({
      party: 'Labour',
      ayes: 2,
      noes: 1,
      majority_direction: 'Aye',
    });
    // And it says what it is measuring, which is not defiance of the whip.
    expect(res.data.rebellions?.basis).toMatch(/whip/i);
  });

  it('is off by default and adds nothing to the response', async () => {
    mock.set({ kind: 'ok', body: DIVISION });
    const res = await call<{ include_rebellions: boolean; rebellions: unknown }>(getDivision, GetDivisionInput, {
      division_id: 1745,
    });
    expect(res.data.include_rebellions).toBe(false);
    expect(res.data.rebellions).toBeNull();
  });

  /** An empty rebel list would read as "nobody rebelled". It must not appear. */
  it('says it could not tell, rather than returning no rebels, when parties are missing', async () => {
    mock.set({
      kind: 'ok',
      body: {
        ...DIVISION,
        Ayes: [{ MemberId: 1, Name: 'Labour One' }],
        Noes: [{ MemberId: 4, Name: 'Labour Rebel' }],
      },
    });
    const res = await call<{ rebellions: unknown; rebellions_note: string }>(getDivision, GetDivisionInput, {
      division_id: 1745,
      include_rebellions: true,
    });

    expect(res.data.rebellions).toBeNull();
    expect(res.data.rebellions_note).toMatch(/no per-member party/);
    expect(res.data.rebellions_note).toMatch(/NOT evidence/);
  });

  it('a timed-out division says so instead of reporting a division with no rebels', async () => {
    mock.set({ kind: 'hang' });
    const res = await call<{ found: boolean; rebellions: unknown; rebellions_note: string }>(
      getDivision,
      GetDivisionInput,
      { division_id: 1745, include_rebellions: true },
    );

    expect(res.data.found).toBe(false);
    expect(res.data.rebellions).toBeNull();
    expect(res.data.rebellions_note).toMatch(/not returned/);
    expect(res.meta.sources_status.commonsVotes?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.commonsVotes)).toBe(false);
  });
});

describe('get_committee returns evidence sessions and publications', () => {
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

  /**
   * One body again: the detail call reads the top level, and the members, oral
   * evidence and publications calls all read `items`, so each row has to be
   * legible as all three.
   */
  const BODY = {
    id: 5,
    name: 'Environmental Audit Committee',
    category: 'Select',
    isCommons: true,
    purpose: 'Scrutinises environmental policy.',
    totalResults: 1,
    items: [
      {
        memberInfo: { mnisId: 4514, displayAs: 'A Member', party: 'Labour', house: 'Commons' },
        roles: [{ role: { name: 'Chair' }, endDate: null }],
        id: 101,
        meetingDate: '2026-05-06T00:00:00',
        publicationDate: '2026-05-10T00:00:00',
        committeeBusinesses: [{ id: 1, title: 'Air quality' }],
        witnesses: [{ name: 'Dr Someone' }, { organisations: [{ name: 'A Charity', role: 'Director' }] }],
        description: 'Air quality: Government Response',
        publicationStartDate: '2026-06-01T00:00:00',
        type: { id: 2, name: 'Report' },
        hcNumber: { number: 'HC 123' },
      },
    ],
  };

  it('asks the evidence collections and returns both', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = await call<{
      include_evidence: boolean;
      evidence: {
        oral_evidence_sessions: Array<{ id: number; inquiry: string | null; witnesses: string[] }> | null;
        publications: Array<{ id: number; title: string | null; type: string | null; paper_number: string | null }> | null;
      } | null;
    }>(getCommittee, GetCommitteeInput, { committee_id: 5, include_evidence: true });

    expect(mock.requests.join()).toContain('/OralEvidence?CommitteeId=5');
    expect(mock.requests.join()).toContain('/Publications?CommitteeId=5');
    expect(res.data.include_evidence).toBe(true);
    expect(res.data.evidence?.oral_evidence_sessions?.[0]).toMatchObject({ id: 101, inquiry: 'Air quality' });
    expect(res.data.evidence?.oral_evidence_sessions?.[0].witnesses).toEqual(['Dr Someone', 'A Charity']);
    expect(res.data.evidence?.publications?.[0]).toMatchObject({
      title: 'Air quality: Government Response',
      type: 'Report',
      paper_number: 'HC 123',
    });
  });

  it('fetches nothing extra when evidence is not asked for', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = await call<{ include_evidence: boolean; evidence: unknown }>(getCommittee, GetCommitteeInput, {
      committee_id: 5,
    });

    expect(mock.requests.join()).not.toContain('/OralEvidence');
    expect(res.data.include_evidence).toBe(false);
    expect(res.data.evidence).toBeNull();
  });

  it('says evidence needs an id when asked for on a name search', async () => {
    mock.set({ kind: 'ok', body: BODY });
    const res = await call<{ evidence: unknown; evidence_note: string }>(getCommittee, GetCommitteeInput, {
      query: 'Environmental Audit',
      include_evidence: true,
    });

    expect(mock.requests.join()).not.toContain('/OralEvidence');
    expect(res.data.evidence).toBeNull();
    expect(res.data.evidence_note).toMatch(/committee_id/);
  });

  it('a degraded evidence collection is null and flagged, never an empty one', async () => {
    mock.set({ kind: 'hang' });
    const res = await call<{
      evidence: { oral_evidence_sessions: unknown; publications: unknown } | null;
      evidence_note: string;
    }>(getCommittee, GetCommitteeInput, { committee_id: 5, include_evidence: true });

    expect(res.data.evidence?.oral_evidence_sessions).toBeNull();
    expect(res.data.evidence?.publications).toBeNull();
    expect(res.data.evidence_note).toMatch(/could not be retrieved/);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.oralEvidence?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.oralEvidence)).toBe(false);
    expect(isReportableAbsence(res.meta.sources_status.publications)).toBe(false);
  });
});

/**
 * Regression test for a false claim found on the deployed server.
 *
 * Division 2409 had two Independents vote Aye while five other Independents
 * voted No, and both were reported as rebels against "the Independent
 * majority". There is no such thing: Independents are independent of each
 * other, so the group has no line to cross. Naming a real person as a rebel on
 * that basis is exactly the kind of false statement this engine exists to stop.
 */
describe('rebellions are not manufactured for groupings with no party line', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('commonsVotes', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
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

  const voters = (party: string, n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({ member_id: from + i, name: `${party} ${from + i}`, party }));

  const body = {
    DivisionId: 2409,
    Title: 'A division',
    Date: '2026-07-01',
    AyeCount: 4,
    NoCount: 7,
    // Two Independents one way, five the other, plus a genuine Labour rebel.
    Ayes: [...voters('Independent', 2, 10), ...voters('Labour', 2, 20)],
    Noes: [...voters('Independent', 5, 30), ...voters('Labour', 2, 40)],
  };

  it('excludes Independents from rebels but still counts their votes', async () => {
    mock.set({ kind: 'ok', body });
    const res = (await getDivision(
      { division_id: 2409, house: 'Commons', include_rebellions: true } as never,
      { requestId: 'TEST' },
    )) as never as {
      data: {
        rebellions: {
          rebels: Array<{ party: string; name: string }>;
          party_majority_direction: Array<{ party: string; ayes: number; noes: number }>;
          groupings_excluded_from_rebellions: string[];
          basis: string;
        };
      };
    };

    const r = res.data.rebellions;
    expect(r.rebels.some((x) => x.party === 'Independent')).toBe(false);
    expect(r.groupings_excluded_from_rebellions).toContain('Independent');

    // The arithmetic stays visible even though nobody is called a rebel for it.
    const ind = r.party_majority_direction.find((p) => p.party === 'Independent');
    expect(ind).toMatchObject({ ayes: 2, noes: 5 });

    // And a real party rebellion is still detected.
    expect(r.basis).toContain('not a count of defied whips');
  });
});
