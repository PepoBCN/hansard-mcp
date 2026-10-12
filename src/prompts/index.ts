import { z } from 'zod';
import { parseDivisionRef } from '../domain/parliamentUrl.js';

/** MCP prompt arguments are strings by specification, so the shape is fixed. */
export type PromptArgSchema = Record<string, z.ZodString | z.ZodOptional<z.ZodString>>;
export type PromptArgs = Record<string, string | undefined>;

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  argsSchema: PromptArgSchema;
  render: (args: PromptArgs) => string;
}

/**
 * Shared rendering contract.
 *
 * Every prompt gets this. It is the whole reason the engine reports per-source
 * status: without it, a model reads an empty array and writes "Parliament has
 * done nothing", which is the defect that started this rebuild.
 */
const CONTRACT = `
## Reading the tool output — non-negotiable

Each response is \`{ data, sources, meta }\`. Before writing a word, read
\`meta.sources_status\`.

- A section that is empty **and** whose source status is \`"ok"\` genuinely has no
  results. Say so plainly.
- A section that is empty with **any other** status (\`timeout\`, \`upstream_error\`,
  \`circuit_open\`, \`unavailable\`) is UNKNOWN. Write "could not be retrieved".
  **Never** write that Parliament has taken no action on it. That would be a false
  statement about the public record.
- \`meta.partial: true\` means at least one section is unknown. Say which, once,
  near the top — do not bury it.
- Where \`data.retrieval\` is present, \`returned_by_upstream > 0\` with
  \`kept_after_relevance: 0\` means results came back but none were on topic. Say
  that, rather than implying nothing exists.

## Citations

Cite the URLs in \`sources\` inline for every factual claim. Never invent a URL.
Close with: "Contains Parliamentary information licensed under the Open Parliament
Licence v3.0."
`.trim();

export const prompts: PromptDefinition[] = [
  {
    name: 'topic-tracker',
    title: 'Brief me on a policy topic',
    description:
      'Narrative briefing on what Parliament is doing about a topic — bills, debates, votes, written questions and petitions.',
    argsSchema: {
      topic: z.string().describe('Short policy topic, e.g. "renters reform". A trailing date phrase is understood.'),
      lookback_days: z.string().optional().describe('Optional days of history, default 90.'),
    },
    render: (a) => {
      const topic = a.topic ?? '';
      const days = Number.parseInt(a.lookback_days ?? '90', 10) || 90;
      return `Brief the user on what Parliament is doing about: **${topic}**

Step 1 — call \`parliament_topic_tracker\` with \`topic="${topic}"\` and
\`lookback_days=${days}\` (a **number**, not a string).

Step 2 — render a markdown briefing with these sections, in this order:
- **Bills in progress** — id, title, current stage. These exclude enacted Acts.
- **Recent debates** — date, title, house, with the Hansard link.
- **Related votes** — date, title, ayes/noes. Note: \`related_votes.date_filtered\`
  is false, so check each item's \`in_window\` flag and say plainly which votes fall
  outside the period asked for rather than presenting them all as recent.
- **Written questions** — date, excerpt, answered or not.
- **Active petitions** — signature count, action.

Open with two or three sentences naming the trend — "the bill has cleared the Lords",
or "activity is dominated by written questions and petitions". If a section is
genuinely empty, say so in one line; if it is unknown, say that instead.

${CONTRACT}`;
    },
  },

  {
    name: 'mp-report-card',
    title: 'One-page profile of an MP',
    description: 'A report card for an MP or Lord, from a name or a postcode.',
    argsSchema: {
      postcode_or_name: z.string().describe('UK postcode (e.g. "SW1A 0AA") or member name (e.g. "Diane Abbott").'),
    },
    render: (a) => `Produce a one-page report card for: **${a.postcode_or_name ?? ''}**

Step 1 — \`parliament_find_member\` with \`query="${a.postcode_or_name ?? ''}"\`.
A postcode resolves to the constituency's sitting MP. If several members match a
name, ask which one rather than guessing.

Step 2 — \`parliament_member_overview\` with the \`member_id\` from step 1.

Step 3 — optionally \`parliament_member_voting_history\` and
\`parliament_member_interests\` if the user wants voting or declarations.

Render:
- **Header** — name, party, constituency, in post since.
- **In their own words** — the synopsis and policy focus, if present.
- **Roles** — ministerial and opposition posts, committee memberships.
- **Contact** — constituency and Westminster details.

\`parliament_member_overview\` fetches each facet independently, so check the status
of each before reporting a section as empty. "No committee memberships" and "the
committee lookup failed" are different claims and only one of them may be made.

${CONTRACT}`,
  },

  {
    name: 'vote-explainer',
    title: 'Explain a division',
    description: 'Plain-English explanation of a Commons or Lords division: motion, result, party breakdown, context.',
    argsSchema: {
      division_id_or_hansard_url: z
        .string()
        .describe('Numeric DivisionId, or a pasted parliament.uk division URL.'),
      house: z.string().optional().describe('"Commons" (default) or "Lords". Inferred from a URL when given.'),
    },
    render: (a) => {
      // The legacy 0.2.0 prompt took an id or a URL in one argument. Resolve it here so
      // the model is handed a number, and say plainly when it could not be read
      // rather than sending it off to look up something meaningless.
      const raw = a.division_id_or_hansard_url ?? '';
      let divisionId = '';
      let inferredHouse: string | undefined;
      let problem: string | undefined;
      try {
        const ref = parseDivisionRef(raw);
        divisionId = String(ref.division_id);
        inferredHouse = ref.house;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      const house = (a.house === 'Lords' ? 'Lords' : a.house === 'Commons' ? 'Commons' : inferredHouse) ?? 'Commons';

      if (problem) {
        return `The division reference "${raw}" could not be read. ${problem}

Tell the user exactly that and ask for either a numeric division id or a
parliament.uk division URL such as
https://votes.parliament.uk/Votes/Commons/Division/1234.

Do not guess a division id, and do not look one up from the text above.

${CONTRACT}`;
      }

      return `Explain division **${divisionId}** in the ${house} in plain English.

Step 1 — \`parliament_get_division\` with \`division_id=${divisionId}\`
(a **number**) and \`house="${house}"\`.

Step 2 — if the motion's subject is unclear from its title, use
\`parliament_search_hansard\` to find the surrounding debate and read it with
\`parliament_get_debate\`.

Render:
- **What was voted on** — the motion in one or two plain sentences. Titles like
  "Draft Climate Change Act 2008 (Credit Limit) Order 2026" mean little to a reader;
  explain what it actually does.
- **The result** — ayes, noes, majority, and who won.
- **How the parties split** — use \`aye_breakdown_by_party\` and
  \`no_breakdown_by_party\`. Call out any party that split notably.
- **Why it mattered** — brief context, only if you have a source for it.

Do not infer a motion's purpose from its title alone. If you could not read the
debate, say the explanation is based on the title only.

${CONTRACT}`;
    },
  },

  {
    name: 'draft-constituent-letter',
    title: 'Draft a letter to an MP',
    description: 'A letter to an MP grounded in their actual voting record and contributions on the issue.',
    argsSchema: {
      member_name_or_postcode: z.string().describe('The MP being written to, by name or the constituent\'s postcode.'),
      issue: z.string().describe('What the constituent wants to write about.'),
    },
    render: (a) => `Draft a constituent letter to **${a.member_name_or_postcode ?? ''}** about
**${a.issue ?? ''}**.

Step 1 — \`parliament_find_member\` to resolve the MP.
Step 2 — \`parliament_topic_tracker\` on the issue, to find what Parliament has
actually done: bills, debates, divisions.
Step 3 — \`parliament_member_voting_history\` for this member, and
\`parliament_get_division\` on any division from step 2 that bears on the issue, to
establish how *this* MP voted.

Then write the letter:
- Polite, specific, one page, first person, from a constituent.
- Ground it in the record: name the bill, the division, the date, how they voted.
- Make one clear ask.

**Accuracy rules, which override fluency.** Only state how the MP voted if you
retrieved that division and it names them. If the voting lookup was degraded, or you
could not confirm a vote, write the letter without that claim and tell the user which
claim you left out and why. Never write "you voted against X" on an inference — a
letter sent to an MP asserting a vote they did not cast is worse than a vaguer letter.

${CONTRACT}`,
  },
];
