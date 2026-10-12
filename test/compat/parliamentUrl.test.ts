/**
 * Stage 2b: the legacy 0.2.0 tools accepted a pasted Hansard link and the rebuild only
 * took internal ids, so pasting a link stopped working.
 *
 * The rule these enforce: a reference that cannot be read is an explicit error
 * naming what was expected. It is never allowed to fall through to an empty
 * result, because "that link could not be understood" and "nothing was said in
 * that debate" are different claims and only one of them is true.
 */
import { describe, it, expect } from 'vitest';
import { parseDebateRef, parseDivisionRef, UnparseableReference } from '../../src/domain/parliamentUrl.js';
import { prompts } from '../../src/prompts/index.js';
import type { EngineError } from '../../src/core/errors.js';
import { tools, rawTools } from '../../src/tools/index.js';
import { z } from 'zod';

const GUID = 'A1B2C3D4-1111-2222-3333-444455556666';

describe('parseDebateRef', () => {
  it('takes a bare ext id unchanged', () => {
    expect(parseDebateRef(GUID)).toEqual({ ext_id: GUID, source: 'ext_id' });
  });

  it('reads the id out of a real Hansard debate URL', () => {
    const url = `https://hansard.parliament.uk/Commons/2026-01-14/debates/${GUID}/ClimateChange`;
    expect(parseDebateRef(url)).toEqual({ ext_id: GUID, source: 'url' });
  });

  it('handles the Lords, a trailing slash and query junk', () => {
    for (const url of [
      `https://hansard.parliament.uk/Lords/2026-01-14/debates/${GUID}/Title/`,
      `https://hansard.parliament.uk/Commons/2026-01-14/debates/${GUID}/Title?utm=x`,
      `http://hansard.parliament.uk/Commons/2026-01-14/debates/${GUID}/Title`,
    ]) {
      expect(parseDebateRef(url).ext_id).toBe(GUID);
    }
  });

  it('records whether it came from a URL or an id', () => {
    expect(parseDebateRef(GUID).source).toBe('ext_id');
    expect(parseDebateRef(`https://hansard.parliament.uk/Commons/2026-01-14/debates/${GUID}/T`).source).toBe('url');
  });

  it('refuses a non-Parliament URL rather than guessing', () => {
    expect(() => parseDebateRef('https://example.com/debates/whatever')).toThrow(UnparseableReference);
  });

  it('refuses a Parliament URL with no debate id in it', () => {
    expect(() => parseDebateRef('https://hansard.parliament.uk/Commons/2026-01-14/')).toThrow(UnparseableReference);
  });

  it('refuses empty input', () => {
    expect(() => parseDebateRef('   ')).toThrow(UnparseableReference);
  });

  /**
   * An unreadable link is the caller's mistake, not a server fault. Reporting it
   * as INTERNAL would tell them to quote a request id and go hunting in the
   * server log for a problem that is not there.
   */
  it('is BAD_INPUT, not INTERNAL', () => {
    try {
      parseDebateRef('https://example.com/x');
      expect.unreachable();
    } catch (error) {
      expect((error as EngineError).code).toBe('BAD_INPUT');
      expect((error as EngineError).remedy).toContain('Do not report this as no results');
    }
  });

  it('says what it expected, so the caller can fix the input', () => {
    try {
      parseDebateRef('https://example.com/x');
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).toContain('Expected');
      expect(String((error as Error).message)).toContain('parliament.uk');
    }
  });
});

describe('parseDivisionRef', () => {
  it('takes a numeric id', () => {
    expect(parseDivisionRef('1234')).toEqual({ division_id: 1234, source: 'division_id' });
  });

  it('reads a votes.parliament.uk division URL and infers the house', () => {
    const r = parseDivisionRef('https://votes.parliament.uk/Votes/Commons/Division/1234');
    expect(r.division_id).toBe(1234);
    expect(r.house).toBe('Commons');
    expect(r.source).toBe('url');
  });

  it('infers the Lords too', () => {
    expect(parseDivisionRef('https://votes.parliament.uk/Votes/Lords/Division/99').house).toBe('Lords');
  });

  it('refuses a URL with no numeric id', () => {
    expect(() => parseDivisionRef('https://votes.parliament.uk/Votes/Commons/Division/')).toThrow(
      UnparseableReference,
    );
  });

  it('refuses free text', () => {
    expect(() => parseDivisionRef('the climate vote last week')).toThrow(UnparseableReference);
  });
});

describe('get_debate accepts a URL as well as an ext id', () => {
  const schema = tools.find((t) => t.name === 'parliament_get_debate')!.inputSchema;

  it('advertises hansard_url', () => {
    const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape as unknown as Record<string, unknown>;
    expect(Object.keys(shape)).toContain('hansard_url');
  });

  it('accepts either one on its own', () => {
    expect(() => schema.parse({ debate_ext_id: GUID })).not.toThrow();
    expect(() =>
      schema.parse({ hansard_url: `https://hansard.parliament.uk/Commons/2026-01-14/debates/${GUID}/T` }),
    ).not.toThrow();
  });

  /**
   * The cross-field rule lives on the tool's own schema. The advertised schema
   * is rebuilt from its shape and so does not carry the `.refine()`, which is
   * documented in compat.ts: the handler re-parses with the tool's schema, so
   * an invalid call still fails with a clear error rather than doing something
   * unexpected.
   */
  it('rejects a call with neither, at the layer that enforces it', () => {
    const own = rawTools.find((t) => t.name === 'parliament_get_debate')!.inputSchema;
    expect(() => own.parse({ limit: 10 })).toThrow();
  });

  it('the description tells the model the rule, since the schema cannot', () => {
    const tool = tools.find((t) => t.name === 'parliament_get_debate')!;
    expect(tool.description).toContain('hansard_url');
  });
});

describe('the vote-explainer prompt takes an id or a URL again', () => {
  const prompt = prompts.find((p) => p.name === 'vote-explainer')!;

  it('advertises the legacy argument name', () => {
    expect(Object.keys(prompt.argsSchema)).toContain('division_id_or_hansard_url');
  });

  it('resolves a URL to the number the tool needs', () => {
    const text = prompt.render({ division_id_or_hansard_url: 'https://votes.parliament.uk/Votes/Commons/Division/1234' });
    expect(text).toContain('division_id=1234');
    expect(text).toContain('house="Commons"');
  });

  it('infers the Lords from the URL when no house is given', () => {
    const text = prompt.render({ division_id_or_hansard_url: 'https://votes.parliament.uk/Votes/Lords/Division/7' });
    expect(text).toContain('house="Lords"');
  });

  it('an explicit house still wins over the URL', () => {
    const text = prompt.render({
      division_id_or_hansard_url: 'https://votes.parliament.uk/Votes/Lords/Division/7',
      house: 'Commons',
    });
    expect(text).toContain('house="Commons"');
  });

  it('still takes a plain number', () => {
    expect(prompt.render({ division_id_or_hansard_url: '55' })).toContain('division_id=55');
  });

  /**
   * The important one. An unreadable reference must produce an instruction to
   * say so, never an instruction to go and look something up anyway.
   */
  it('tells the model to report an unreadable reference, not to guess', () => {
    const text = prompt.render({ division_id_or_hansard_url: 'the one about climate' });
    expect(text).toContain('could not be read');
    expect(text).toContain('Do not guess');
    expect(text).not.toContain('Step 1');
  });
});
