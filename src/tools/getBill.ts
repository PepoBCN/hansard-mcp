import { z } from 'zod';
import { getBill as fetchBill, getBillStages, type BillDetail, type BillStage } from '../clients/bills.js';
import { Citations } from '../domain/citations.js';
import { withSources, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const GetBillInput = z.object({
  bill_id: z.coerce.number().int().min(1).describe('Bill id, e.g. from parliament_topic_tracker.'),
  include_stages: z.coerce.boolean().default(true).catch(true),
});

export async function getBill(input: z.infer<typeof GetBillInput>, ctx: { requestId: string }) {
  return withSources(
    {
      tool: 'parliament_get_bill',
      requestId: ctx.requestId,
      sources: {
        bills: (s) => fetchBill({ billId: input.bill_id, signal: s }),
        ...(input.include_stages
          ? { stages: (s: AbortSignal) => getBillStages({ billId: input.bill_id, signal: s }) }
          : {}),
      },
    },
    (get) => {
      const bill = get<BillDetail>('bills');
      const stages = get<BillStage[]>('stages') ?? [];
      return {
        data: {
          bill_id: input.bill_id,
          found: bill !== null,
          short_title: bill?.shortTitle ?? null,
          long_title: bill?.longTitle ?? null,
          summary: bill?.summary ?? null,
          // is_act is reported explicitly: an Act is law, not a bill in progress.
          is_act: bill?.isAct ?? null,
          is_defeated: bill?.isDefeated ?? null,
          current_house: bill?.currentHouse ?? null,
          originating_house: bill?.originatingHouse ?? null,
          current_stage: bill?.currentStage?.description ?? null,
          last_update: bill?.lastUpdate ?? null,
          sponsors:
            bill?.sponsors?.map((sp) => ({
              name: sp.member?.name ?? null,
              party: sp.member?.party ?? null,
              member_id: sp.member?.memberId ?? null,
            })) ?? [],
          stages: stages.map((st) => ({
            id: st.id,
            description: st.description ?? null,
            house: st.house ?? null,
            sittings: (st.stageSittings ?? []).map((x) => x.date).filter(Boolean),
          })),
        },
        citations: bill ? [Citations.bill(input.bill_id, bill.shortTitle)] : [],
      };
    },
  );
}

export const getBillTool: ToolDefinition<typeof GetBillInput> = {
  name: 'parliament_get_bill',
  title: 'Get a bill',
  description: [
    'Full detail on one bill: titles, summary, sponsors, current stage and its stage history.',
    '',
    '`is_act: true` means it has received Royal Assent and is law — not a bill still in progress.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: GetBillInput,
  annotations: READ_ONLY,
  handler: getBill,
};
