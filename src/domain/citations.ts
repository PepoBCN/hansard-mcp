import type { Source } from '../envelope.js';

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

export const Citations = {
  member: (id: number, name: string): Source => ({
    title: `Member: ${name}`,
    url: `https://members.parliament.uk/member/${id}/career`,
  }),
  constituency: (id: number, name: string): Source => ({
    title: `Constituency: ${name}`,
    url: `https://members.parliament.uk/constituency/${id}`,
  }),
  bill: (id: number, title: string): Source => ({
    title: `Bill: ${title}`,
    url: `https://bills.parliament.uk/bills/${id}`,
  }),
  division: (house: 'Commons' | 'Lords', id: number, title: string): Source => ({
    title: `Division ${id}: ${title}`,
    url: `https://votes.parliament.uk/Votes/${house}/Division/${id}`,
  }),
  hansardDebate: (house: string, date: string, extId: string, title: string): Source => ({
    title: `Hansard: ${title}`,
    url: `https://hansard.parliament.uk/${house}/${date.slice(0, 10)}/debates/${extId}/${slug(title)}`,
  }),
  petition: (id: number, action: string): Source => ({
    title: `Petition: ${action}`,
    url: `https://petition.parliament.uk/petitions/${id}`,
  }),
  writtenQuestion: (uin: string, house: string): Source => ({
    title: `Written question ${uin} (${house})`,
    url: `https://questions-statements.parliament.uk/written-questions/detail/${uin}`,
  }),
};

/** Collects up to `limit` citations, skipping items that cannot produce one. */
export function collectSources<T>(items: T[], build: (item: T) => Source | null, limit: number): Source[] {
  const out: Source[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    try {
      const s = build(item);
      if (s?.url) out.push(s);
    } catch {
      /* a citation that cannot be built is skipped, never fabricated */
    }
  }
  return out;
}
