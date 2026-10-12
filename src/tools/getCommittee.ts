import { z } from 'zod';
import {
  getCommittee as fetchCommittee,
  getCommitteeMembers,
  getCommitteeOralEvidence,
  getCommitteePublications,
  searchCommittees,
  type CommitteeSummary,
  type CommitteeMember,
  type CommitteePublication,
  type OralEvidenceSession,
} from '../clients/committees.js';
import { withSources, page, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const GetCommitteeInput = z.object({
  committee_id: z.coerce.number().int().min(1).optional().describe('Committee id. Omit to search by name instead.'),
  query: z.string().min(2).optional().describe('Committee name to search for, when the id is unknown.'),
  include_evidence: z
    .boolean()
    .optional()
    .default(false)
    .describe('Also return the committee\'s oral evidence sessions and its publications, most recent first. Needs `committee_id`.'),
  limit: z.coerce.number().int().min(1).max(50).default(20).catch(20),
  offset: z.coerce.number().int().min(0).default(0).catch(0),
}).refine((v) => v.committee_id !== undefined || v.query !== undefined, {
  message: 'Provide either committee_id or query.',
});

export async function getCommittee(
  input: z.infer<typeof GetCommitteeInput>,
  ctx: { requestId: string },
) {
  const byId = input.committee_id !== undefined;
  // Evidence hangs off two collections of its own, keyed by committee id. A name
  // search has not identified a committee yet, so there is nothing to ask for.
  const wantEvidence = input.include_evidence && byId;
  return withSources(
    {
      tool: 'parliament_get_committee',
      requestId: ctx.requestId,
      sources: byId
        ? {
            committees: (s) => fetchCommittee({ committeeId: input.committee_id!, signal: s }),
            members: (s) => getCommitteeMembers({ committeeId: input.committee_id!, signal: s }),
            ...(wantEvidence
              ? {
                  oralEvidence: (s: AbortSignal) =>
                    getCommitteeOralEvidence({ committeeId: input.committee_id!, take: input.limit, signal: s }),
                  publications: (s: AbortSignal) =>
                    getCommitteePublications({ committeeId: input.committee_id!, take: input.limit, signal: s }),
                }
              : {}),
          }
        : {
            committees: (s) =>
              searchCommittees({ searchTerm: input.query, skip: input.offset, take: input.limit, signal: s }),
          },
    },
    (get) => {
      const detail = byId ? get<CommitteeSummary>('committees') : null;
      const members = byId ? get<CommitteeMember[]>('members') ?? [] : [];
      const search = byId ? null : get<{ items: CommitteeSummary[]; total: number }>('committees');
      const list = search?.items ?? [];

      // Null, never an empty array, when a collection did not come back: an
      // empty list here would read as a committee that has taken no evidence.
      const oral = wantEvidence ? get<{ items: OralEvidenceSession[]; total: number }>('oralEvidence') : null;
      const pubs = wantEvidence ? get<{ items: CommitteePublication[]; total: number }>('publications') : null;

      const houseOf = (c: CommitteeSummary | null) =>
        !c
          ? null
          : c.house ?? (c.isCommons && c.isLords ? 'Joint' : c.isLords ? 'Lords' : c.isCommons ? 'Commons' : null);

      return {
        data: {
          mode: byId ? 'detail' : 'search',
          committee_id: input.committee_id ?? null,
          found: byId ? detail !== null : list.length > 0,
          name: detail?.name ?? null,
          category: detail?.category ?? null,
          house: houseOf(detail),
          purpose: detail?.purpose ?? null,
          start_date: detail?.startDate ?? null,
          end_date: detail?.endDate ?? null,
          members: members.map((m) => ({
            member_id: m.memberInfo?.mnisId ?? null,
            name: m.memberInfo?.displayAs ?? m.name ?? null,
            party: m.memberInfo?.party ?? null,
            house: m.memberInfo?.house ?? null,
            roles: (m.roles ?? [])
              .filter((r) => !r.endDate)
              .map((r) => r.role?.name)
              .filter(Boolean),
          })),
          committees: list.map((c) => ({
            committee_id: c.id,
            name: c.name,
            category: c.category ?? null,
            house: houseOf(c),
          })),
          include_evidence: input.include_evidence,
          evidence: wantEvidence
            ? {
                oral_evidence_sessions:
                  oral?.items.map((e) => ({
                    id: e.id,
                    meeting_date: e.meetingDate ?? null,
                    published: e.publicationDate ?? null,
                    inquiry: e.committeeBusinesses?.[0]?.title ?? null,
                    witnesses: (e.witnesses ?? [])
                      .map((w) => w.name ?? w.organisations?.map((o) => o.name).filter(Boolean).join(', ') ?? null)
                      .filter((n): n is string => Boolean(n)),
                  })) ?? null,
                oral_evidence_total: oral?.total ?? null,
                publications:
                  pubs?.items.map((p) => ({
                    id: p.id,
                    title: p.description ?? null,
                    type: p.type?.name ?? null,
                    published: p.publicationStartDate ?? null,
                    paper_number: p.hcNumber?.number ?? p.hlPaper?.number ?? null,
                  })) ?? null,
                publications_total: pubs?.total ?? null,
              }
            : null,
          ...(input.include_evidence && !byId
            ? {
                evidence_note:
                  'include_evidence was requested but no evidence was fetched: it is keyed by committee id, and this call was a name search. Pick a committee_id from `committees` and call again with it.',
              }
            : {}),
          ...(wantEvidence && (oral === null || pubs === null)
            ? {
                evidence_note:
                  'Part of the evidence could not be retrieved; the collection that failed is null rather than empty. Check meta.sources_status for oralEvidence and publications before reporting that this committee has taken no evidence or published nothing.',
              }
            : {}),
          ...page(input.offset, input.limit, list.length, search?.total ?? list.length),
        },
        citations: [],
      };
    },
  );
}

export const getCommitteeTool: ToolDefinition<typeof GetCommitteeInput> = {
  name: 'parliament_get_committee',
  title: 'Get or search select committees',
  description: [
    'With `committee_id`: the committee\'s remit and full membership with roles. With `query`: search committees by name to find an id.',
    '',
    'By default this covers committee *structure* — who sits on what.',
    '',
    '`include_evidence` adds `evidence`: the committee\'s oral evidence sessions with their witnesses, and its publications (reports, government responses, formal minutes) with paper numbers. It needs `committee_id`; asked for on a name search, nothing is fetched and `evidence_note` says to call again with an id. If either collection fails it is null rather than empty, so a retrieval failure cannot read as a committee that has taken no evidence.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: GetCommitteeInput,
  annotations: READ_ONLY,
  handler: getCommittee,
};
