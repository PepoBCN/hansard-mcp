import { z } from 'zod';
import { getDebateByExtId, type DebateDetail } from '../clients/hansard.js';
import { Citations } from '../domain/citations.js';
import { parseDebateRef } from '../domain/parliamentUrl.js';
import { withSources, page, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const GetDebateInput = z
  .object({
    debate_ext_id: z
      .string()
      .min(8)
      .optional()
      .describe('DebateSectionExtId, e.g. from parliament_search_hansard or parliament_topic_tracker.'),
    hansard_url: z
      .string()
      .min(8)
      .optional()
      .describe('A pasted hansard.parliament.uk debate URL, used when the ext id is not to hand.'),
    limit: z.coerce.number().int().min(1).max(400).default(100).catch(100),
    offset: z.coerce.number().int().min(0).default(0).catch(0),
  })
  .refine((v) => v.debate_ext_id !== undefined || v.hansard_url !== undefined, {
    message: 'Provide either debate_ext_id or hansard_url.',
  });

export async function getDebate(input: z.infer<typeof GetDebateInput>, ctx: { requestId: string }) {
  // A URL that cannot be read throws here, naming what was expected. It must
  // never fall through to an empty debate, which would read as "nothing was
  // said" rather than "that link could not be understood".
  const ref = parseDebateRef(input.debate_ext_id ?? input.hansard_url ?? '');
  const extId = ref.ext_id;

  return withSources(
    {
      tool: 'parliament_get_debate',
      requestId: ctx.requestId,
      sources: { hansard: (s) => getDebateByExtId({ extId, signal: s }) },
    },
    (get) => {
      const d = get<DebateDetail>('hansard');
      const all = (d?.Items ?? []).filter((i) => (i.Value ?? '').trim().length > 0);
      const slice = all.slice(input.offset, input.offset + input.limit);
      const ov = d?.Overview;

      return {
        data: {
          debate_ext_id: extId,
          resolved_from: ref.source,
          found: d !== null,
          title: ov?.Title ?? null,
          house: ov?.House ?? null,
          date: ov?.Date ?? null,
          location: ov?.Location ?? null,
          speaker_count: new Set(all.map((i) => i.MemberName).filter(Boolean)).size,
          contributions: slice.map((i) => ({
            member_name: i.MemberName ?? i.AttributedTo ?? null,
            member_id: i.MemberId ?? null,
            type: i.ItemType ?? null,
            // Hansard embeds markup in contribution text; strip it for reading.
            text: (i.Value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
          })),
          ...page(input.offset, input.limit, slice.length, all.length),
        },
        citations:
          d && ov?.House && ov?.Date && ov?.ExtId
            ? [Citations.hansardDebate(ov.House, ov.Date, ov.ExtId, ov.Title ?? 'Debate')]
            : [],
      };
    },
  );
}

export const getDebateTool: ToolDefinition<typeof GetDebateInput> = {
  name: 'parliament_get_debate',
  title: 'Get the text of a debate',
  description: [
    'Full contributions for one Hansard debate, in order, with speaker names and member ids. Paginated — long debates run to hundreds of contributions.',
    '',
    'Find a debate_ext_id with parliament_search_hansard or parliament_topic_tracker first, or pass a pasted hansard.parliament.uk debate URL as hansard_url instead.',
    '',
    'A URL that cannot be read is an error naming what was expected, never an empty debate.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: GetDebateInput,
  annotations: READ_ONLY,
  handler: getDebate,
};
