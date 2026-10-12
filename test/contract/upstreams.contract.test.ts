import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { UPSTREAMS, type SourceKey } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';

/**
 * Contract tests against the LIVE Parliament APIs.
 *
 * These do not test our logic; they test that Parliament still returns the shapes
 * we parse. Parliament changes field shapes without notice — three such breaks
 * were found by hand during the build (there is no /Members/{id}/GovernmentPosts
 * endpoint, party names are nested under value.party, written-question rows are
 * wrapped in {value}). This suite turns the next one into a 3am alert instead of
 * a client noticing.
 *
 * Excluded from the default run because they need network and are therefore
 * flaky by nature. Run nightly:
 *
 *     npm run test:contract
 */
const ACCEPT = { accept: 'application/json', 'user-agent': 'parliament-mcp-engine/contract-test' };

async function fetchJson(url: string, timeoutMs = 30_000): Promise<unknown> {
  const res = await fetch(url, { headers: ACCEPT, signal: AbortSignal.timeout(timeoutMs) });
  expect(res.ok, `${url} -> HTTP ${res.status}`).toBe(true);
  return res.json();
}

/**
 * The written-questions endpoint measured 25.1s cold against 0.24s warm, and a
 * 500 at 32s. A contract test must outlast that, or it reports a shape break
 * every time the CDN is cold.
 */
const SLOW = 75_000;

const base = (k: SourceKey) => UPSTREAMS[k].base;

beforeAll(async () => {
  await cache.clear();
});

describe('upstream contracts', () => {
  it('members: search returns items[].value with id and nameDisplayAs', async () => {
    const body = await fetchJson(`${base('members')}/Members/Search?Name=Abbott&IsCurrentMember=true&take=1`);
    const schema = z.object({
      items: z.array(z.object({
        value: z.object({
          id: z.number(),
          nameDisplayAs: z.string(),
          latestParty: z.object({ name: z.string().optional() }).nullish(),
        }),
      })).min(1),
      totalResults: z.number(),
    });
    expect(schema.safeParse(body).success, JSON.stringify(schema.safeParse(body).error?.issues)).toBe(true);
  });

  it('members: biography carries the post collections (there is no per-post endpoint)', async () => {
    const body = await fetchJson(`${base('members')}/Members/172/Biography`);
    const post = z.object({ name: z.string().optional(), startDate: z.string().optional(), additionalInfo: z.string().nullish() });
    const schema = z.object({
      value: z.object({
        governmentPosts: z.array(post),
        oppositionPosts: z.array(post),
        committeeMemberships: z.array(post),
      }),
    });
    expect(schema.safeParse(body).success, JSON.stringify(schema.safeParse(body).error?.issues)).toBe(true);
  });

  it('members: state of the parties nests the name under value.party', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const body = await fetchJson(`${base('members')}/Parties/StateOfTheParties/1/${today}`);
    const schema = z.object({
      items: z.array(z.object({
        value: z.object({ total: z.number(), party: z.object({ name: z.string() }) }),
      })).min(1),
    });
    expect(schema.safeParse(body).success, JSON.stringify(schema.safeParse(body).error?.issues)).toBe(true);
  });

  it('postcodes: lookup exposes the 2024 constituency', async () => {
    const body = await fetchJson(`${base('postcodes')}/postcodes/SW1A0AA`);
    const schema = z.object({
      status: z.literal(200),
      result: z.object({
        postcode: z.string(),
        parliamentary_constituency_2024: z.string().nullish(),
      }),
    });
    expect(schema.safeParse(body).success).toBe(true);
  });

  it('bills: search returns items[] with billId, shortTitle, isAct', async () => {
    const body = await fetchJson(`${base('bills')}/Bills?SearchTerm=climate&Take=1`);
    const schema = z.object({
      items: z.array(z.object({ billId: z.number(), shortTitle: z.string(), isAct: z.boolean() })).min(1),
    });
    expect(schema.safeParse(body).success, JSON.stringify(schema.safeParse(body).error?.issues)).toBe(true);
  });

  it('hansard: debate search returns Results[] with DebateSectionExtId', async () => {
    const body = await fetchJson(
      `${base('hansard')}/search/debates.json?queryParameters.searchTerm=climate&queryParameters.take=1`,
    );
    const schema = z.object({
      Results: z.array(z.object({
        DebateSectionExtId: z.string(),
        Title: z.string(),
        House: z.string(),
        SittingDate: z.string(),
      })).min(1),
    });
    expect(schema.safeParse(body).success, JSON.stringify(schema.safeParse(body).error?.issues)).toBe(true);
  });

  it('commonsVotes: division search returns a bare array with DivisionId', async () => {
    const body = await fetchJson(
      `${base('commonsVotes')}/divisions.json/search?queryParameters.searchTerm=climate&queryParameters.take=1`,
    );
    const schema = z.array(z.object({
      DivisionId: z.number(),
      Title: z.string(),
      Date: z.string(),
      AyeCount: z.number(),
      NoCount: z.number(),
    })).min(1);
    expect(schema.safeParse(body).success, JSON.stringify(schema.safeParse(body).error?.issues)).toBe(true);
  });

  it('petitions: returns data[] with attributes.action and signature_count', async () => {
    const body = await fetchJson(`${base('petitions')}/petitions.json?state=open`);
    const schema = z.object({
      data: z.array(z.object({
        id: z.number(),
        attributes: z.object({
          action: z.string(),
          signature_count: z.number(),
          state: z.string(),
        }),
      })).min(1),
    });
    expect(schema.safeParse(body).success).toBe(true);
  });

  it('writtenQuestions: rows are wrapped in {value}', async () => {
    const body = await fetchJson(`${base('writtenQuestions')}/questions?searchTerm=health&take=1`, SLOW);
    const schema = z.object({
      results: z.array(z.object({
        value: z.object({ uin: z.string(), questionText: z.string().nullable(), dateTabled: z.string() }),
      })).min(1),
    });
    expect(schema.safeParse(body).success, JSON.stringify(schema.safeParse(body).error?.issues)).toBe(true);
  });

  it('writtenQuestions: searchTerm is documented-inert, so relevance filtering is required', async () => {
    // Not a shape check but a standing assumption. If Parliament ever fixes this
    // endpoint, totalResults will drop and this test will tell us we can relax
    // the client-side ranking.
    const body = (await fetchJson(`${base('writtenQuestions')}/questions?searchTerm=renters%20reform&take=1`, SLOW)) as {
      totalResults?: number;
    };
    expect(body.totalResults, 'searchTerm appears to filter now — revisit the relevance layer').toBeGreaterThan(1000);
  });

  it('committees: search returns items[] with id and name', async () => {
    const body = await fetchJson(`${base('committees')}/Committees?SearchTerm=Treasury&Take=1`);
    const schema = z.object({ items: z.array(z.object({ id: z.number(), name: z.string() })).min(1) });
    expect(schema.safeParse(body).success).toBe(true);
  });

  it('interests: returns items[] for a member', async () => {
    const body = await fetchJson(`${base('interests')}/Interests/?MemberId=172&Take=1`);
    const schema = z.object({ items: z.array(z.unknown()) });
    expect(schema.safeParse(body).success).toBe(true);
  });

  it('lordsVotes: member voting returns an array', async () => {
    const body = await fetchJson(`${base('lordsVotes')}/Divisions/membervoting?MemberId=3898&take=1`);
    expect(Array.isArray(body)).toBe(true);
  });
});
