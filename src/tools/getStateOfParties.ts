import { z } from 'zod';
import { getStateOfParties as fetchState, type PartyStanding } from '../clients/members.js';
import { withSources, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const GetStateOfPartiesInput = z.object({
  house: z.enum(['Commons', 'Lords']).default('Commons'),
  for_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('ISO date (YYYY-MM-DD) for a historical standing. Defaults to today.'),
});

export async function getStateOfParties(
  input: z.infer<typeof GetStateOfPartiesInput>,
  ctx: { requestId: string },
) {
  return withSources(
    {
      tool: 'parliament_get_state_of_parties',
      requestId: ctx.requestId,
      sources: {
        members: (s) => fetchState({ house: input.house, forDate: input.for_date, signal: s }),
      },
    },
    (get) => {
      const parties = (get<PartyStanding[]>('members') ?? []).slice().sort((a, b) => b.total - a.total);
      const seats = parties.reduce((n, p) => n + p.total, 0);
      const largest = parties[0];

      return {
        data: {
          house: input.house,
          as_at: input.for_date ?? new Date().toISOString().slice(0, 10),
          total_seats: seats,
          // A working majority needs more than half the seats; in the Commons
          // this is the number people actually mean by "does X have a majority".
          majority_threshold: seats > 0 ? Math.floor(seats / 2) + 1 : null,
          largest_party: largest
            ? { name: largest.name, seats: largest.total, has_majority: seats > 0 && largest.total > seats / 2 }
            : null,
          parties: parties.map((p) => ({
            name: p.name,
            abbreviation: p.abbreviation ?? null,
            seats: p.total,
            share_pct: seats > 0 ? Math.round((p.total / seats) * 1000) / 10 : null,
          })),
        },
        citations: [
          {
            title: `State of the parties, ${input.house}`,
            url: `https://members.parliament.uk/parties/${input.house === 'Lords' ? 'Lords' : 'Commons'}`,
          },
        ],
      };
    },
  );
}

export const getStateOfPartiesTool: ToolDefinition<typeof GetStateOfPartiesInput> = {
  name: 'parliament_get_state_of_parties',
  title: 'Party standings in a House',
  description: [
    'Seat counts by party for the Commons or Lords, with each party\'s share and whether the largest party holds an outright majority.',
    '',
    'Pass `for_date` for a historical standing.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: GetStateOfPartiesInput,
  annotations: READ_ONLY,
  handler: getStateOfParties,
};
