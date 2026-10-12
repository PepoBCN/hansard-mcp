import { z } from 'zod';
import { searchConstituencies, type ConstituencyValue } from '../clients/members.js';
import { lookupPostcode, looksLikePostcode } from '../clients/postcodes.js';
import { Citations, collectSources } from '../domain/citations.js';
import { withSources, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const FindConstituencyInput = z.object({
  query: z.string().min(2).describe('Constituency name (e.g. "Islington North") or a UK postcode.'),
  limit: z.coerce.number().int().min(1).max(50).default(10).catch(10),
});

export async function findConstituency(
  input: z.infer<typeof FindConstituencyInput>,
  ctx: { requestId: string },
) {
  const isPostcode = looksLikePostcode(input.query);

  return withSources(
    {
      tool: 'parliament_find_constituency',
      requestId: ctx.requestId,
      sources: isPostcode
        ? {
            postcodes: (s) => lookupPostcode({ postcode: input.query, signal: s }),
          }
        : {
            members: (s) => searchConstituencies({ searchText: input.query, take: input.limit, signal: s }),
          },
    },
    (get) => {
      const pc = isPostcode
        ? get<{ postcode: string; constituency: string | null; district: string | null }>('postcodes')
        : null;
      const items = isPostcode ? [] : get<ConstituencyValue[]>('members') ?? [];

      return {
        data: {
          query: input.query,
          resolved_from: isPostcode ? 'postcode' : 'name',
          postcode: pc?.postcode ?? null,
          matched_constituency_name: pc?.constituency ?? null,
          local_authority: pc?.district ?? null,
          constituencies: items.map((c) => ({
            constituency_id: c.id,
            name: c.name,
            current_member: c.currentRepresentation?.member?.value
              ? {
                  member_id: c.currentRepresentation.member.value.id,
                  name: c.currentRepresentation.member.value.nameDisplayAs,
                  party: c.currentRepresentation.member.value.latestParty?.name ?? null,
                }
              : null,
          })),
        },
        citations: collectSources(items, (c) => Citations.constituency(c.id, c.name), 5),
      };
    },
  );
}

export const findConstituencyTool: ToolDefinition<typeof FindConstituencyInput> = {
  name: 'parliament_find_constituency',
  title: 'Find a constituency',
  description: [
    'Resolve a constituency name or UK postcode to its constituency_id and current MP.',
    '',
    'A postcode sets `matched_constituency_name` (chain it back through this tool by name for the id); a name populates `constituencies` with ids and sitting members.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: FindConstituencyInput,
  annotations: READ_ONLY,
  handler: findConstituency,
};
