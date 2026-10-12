/**
 * Stage 1 of the compatibility work: the engine must accept the legacy 0.2.0 input names.
 *
 * These run offline. They assert on the advertised schemas and on the rename
 * mapping, which is where the behaviour actually lives; the tools themselves
 * are untouched by the compat layer and are already covered elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tools, rawTools } from '../../src/tools/index.js';
import { conciseEnvelope, normaliseArgs, NOT_YET_SUPPORTED } from '../../src/compat.js';

const byName = (name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
};

const shapeOf = (name: string) =>
  (byName(name).inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape as unknown as Record<
    string,
    z.ZodTypeAny
  >;

describe('the compat layer does not change the tool surface itself', () => {
  it('still exposes exactly the 15 tools, with the same names', () => {
    expect(tools).toHaveLength(15);
    expect(tools.map((t) => t.name).sort()).toEqual(rawTools.map((t) => t.name).sort());
  });

  it('keeps every tool read-only', () => {
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });
});

describe('response_format is on all 15 tools', () => {
  it('advertises it everywhere', () => {
    for (const tool of tools) {
      expect(Object.keys(shapeOf(tool.name)), tool.name).toContain('response_format');
    }
  });

  it('accepts both values, and defaults to concise', () => {
    for (const tool of tools) {
      const field = shapeOf(tool.name).response_format;
      expect(field.parse(undefined), tool.name).toBe('concise');
      expect(field.parse('detailed'), tool.name).toBe('detailed');
      expect(() => field.parse('verbose')).toThrow();
    }
  });
});

/**
 * The load-bearing test. `concise` shortens free text and nothing else. If it
 * could drop a status, a failed lookup would read as an empty result again,
 * which is the bug this engine was built to prevent.
 */
describe('concise never touches meta or sources', () => {
  const envelope = {
    data: {
      debates: [{ title: 'A debate', text: 'x'.repeat(900), id: 12 }],
      total: 1,
      date_filtered: false,
    },
    sources: [{ title: 'Hansard', url: 'https://hansard.parliament.uk/x' }],
    meta: {
      request_id: 'REQ',
      partial: true,
      warnings: ['written_questions timed out'],
      sources_status: {
        hansard: { status: 'ok' },
        written_questions: { status: 'timeout' },
      },
    },
  };

  it('leaves meta byte-for-byte identical', () => {
    const out = conciseEnvelope(envelope) as typeof envelope;
    expect(out.meta).toEqual(envelope.meta);
    expect(out.meta.sources_status.written_questions.status).toBe('timeout');
    expect(out.meta.partial).toBe(true);
  });

  it('leaves sources identical', () => {
    const out = conciseEnvelope(envelope) as typeof envelope;
    expect(out.sources).toEqual(envelope.sources);
  });

  it('shortens long free text but keeps every key and every count', () => {
    const out = conciseEnvelope(envelope) as typeof envelope;
    expect(out.data.total).toBe(1);
    expect(out.data.date_filtered).toBe(false);
    expect(Object.keys(out.data.debates[0])).toEqual(['title', 'text', 'id']);
    expect(out.data.debates[0].id).toBe(12);
    expect(out.data.debates[0].title).toBe('A debate');
    expect(out.data.debates[0].text.length).toBeLessThan(400);
  });

  it('is a no-op on anything that is not an envelope', () => {
    expect(conciseEnvelope(null)).toBeNull();
    expect(conciseEnvelope({ meta: {} })).toEqual({ meta: {} });
  });
});

describe('legacy input names are advertised and mapped', () => {
  const cases: Array<{ tool: string; legacy: string; canonical: string; value: unknown; expected?: unknown }> = [
    { tool: 'parliament_search_divisions', legacy: 'topic', canonical: 'query', value: 'climate change' },
    { tool: 'parliament_get_committee', legacy: 'name', canonical: 'query', value: 'Environmental Audit' },
    { tool: 'parliament_get_state_of_parties', legacy: 'on_date', canonical: 'for_date', value: '2026-01-31' },
    { tool: 'parliament_get_state_of_parties', legacy: 'assembly', canonical: 'house', value: 'Lords' },
    { tool: 'parliament_member_voting_history', legacy: 'assembly', canonical: 'house', value: 'Commons' },
    { tool: 'parliament_search_hansard', legacy: 'assembly', canonical: 'house', value: 'both' },
    { tool: 'parliament_get_division', legacy: 'assembly', canonical: 'house', value: 'Lords' },
  ];

  for (const c of cases) {
    it(`${c.tool}: advertises ${c.legacy}`, () => {
      expect(Object.keys(shapeOf(c.tool))).toContain(c.legacy);
    });

    it(`${c.tool}: maps ${c.legacy} onto ${c.canonical}`, () => {
      const out = normaliseArgs(c.tool, { [c.legacy]: c.value });
      expect(out[c.canonical]).toBe(c.expected ?? c.value);
      expect(out[c.legacy]).toBeUndefined();
    });
  }

  it('accepts the chamber case-insensitively, as a legacy caller might send it', () => {
    expect(normaliseArgs('parliament_get_division', { assembly: 'lords' }).house).toBe('Lords');
    expect(normaliseArgs('parliament_get_division', { assembly: 'COMMONS' }).house).toBe('Commons');
  });

  it('drops an unrecognised chamber rather than passing rubbish through', () => {
    const out = normaliseArgs('parliament_get_division', { assembly: 'Senate' });
    expect(out.house).toBeUndefined();
    expect(out.assembly).toBeUndefined();
  });

  it('never lets a legacy name override the canonical one', () => {
    const out = normaliseArgs('parliament_search_divisions', { topic: 'legacy', query: 'canonical' });
    expect(out.query).toBe('canonical');
  });

  it('leaves canonical-only calls completely alone', () => {
    const args = { query: 'climate change', limit: 5 };
    expect(normaliseArgs('parliament_search_divisions', args)).toEqual(args);
  });
});

/**
 * Regression test for a bug this suite originally missed.
 *
 * The first version tested `normaliseArgs` in isolation and passed, while the
 * deployed server silently ignored `assembly` and returned Commons data for
 * `assembly: "Lords"`. The SDK parses with the widened schema *before* the
 * handler runs, so `house` arrived pre-filled with its default, the rename saw
 * a value already present and declined to overwrite it.
 *
 * So these go through the real path: parse with the advertised schema exactly
 * as the server does, then normalise. Testing the rename alone is not enough.
 */
describe('a legacy chamber survives schema parsing, not just the rename', () => {
  const cases = [
    { tool: 'parliament_get_state_of_parties', sent: { assembly: 'Lords' }, house: 'Lords' },
    { tool: 'parliament_get_division', sent: { division_id: 1, assembly: 'Lords' }, house: 'Lords' },
    { tool: 'parliament_member_voting_history', sent: { member_id: 1, assembly: 'Lords' }, house: 'Lords' },
    { tool: 'parliament_search_hansard', sent: { query: 'climate', assembly: 'Lords' }, house: 'Lords' },
  ];

  for (const c of cases) {
    it(`${c.tool}: assembly "${c.house}" is not overwritten by the default`, () => {
      const parsed = byName(c.tool).inputSchema.parse(c.sent) as Record<string, unknown>;
      const out = normaliseArgs(c.tool, parsed);
      expect(out.house).toBe(c.house);
    });
  }

  it('still defaults the chamber when neither name is given', () => {
    const parsed = byName('parliament_get_state_of_parties').inputSchema.parse({}) as Record<string, unknown>;
    const normalised = normaliseArgs('parliament_get_state_of_parties', parsed);
    // The default belongs to the tool's own schema, applied after the rename.
    const final = rawTools
      .find((t) => t.name === 'parliament_get_state_of_parties')!
      .inputSchema.parse(normalised) as Record<string, unknown>;
    expect(final.house).toBe('Commons');
  });

  it('an explicit canonical house still wins over a legacy assembly', () => {
    const parsed = byName('parliament_get_state_of_parties').inputSchema.parse({
      house: 'Commons',
      assembly: 'Lords',
    }) as Record<string, unknown>;
    expect(normaliseArgs('parliament_get_state_of_parties', parsed).house).toBe('Commons');
  });
});

describe('search_divisions accepts topic without query, as the 0.2.0 surface did', () => {
  it('no longer requires query at the advertised schema', () => {
    const schema = byName('parliament_search_divisions').inputSchema;
    expect(() => schema.parse({ topic: 'climate change' })).not.toThrow();
  });
});

/**
 * Guards the honesty rule: a parameter that is not yet honoured must not be
 * advertised, because a caller cannot tell an ignored parameter from an
 * applied one.
 */
describe('parameters that are not yet honoured are not advertised', () => {
  const entries = Object.entries(NOT_YET_SUPPORTED);

  /**
   * Currently empty, which is the goal state: every parameter on the 0.2.0 surface
   * is accepted and honoured. This test still earns its place, because the day
   * something has to be deferred again it must be listed rather than advertised
   * and quietly dropped.
   */
  it('is empty, meaning nothing on the legacy surface is unhonoured', () => {
    expect(entries.map(([tool, params]) => `${tool}: ${params.join(', ')}`)).toEqual([]);
  });

  for (const [toolName, params] of entries) {
    it(`${toolName} does not advertise: ${params.join(', ')}`, () => {
      const advertised = Object.keys(shapeOf(toolName));
      for (const p of params) {
        if (p.includes(' ')) continue; // prose entries such as "no-member listing"
        expect(advertised, `${toolName}.${p}`).not.toContain(p);
      }
    });
  }
});
