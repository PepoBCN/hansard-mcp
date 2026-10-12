import { describe, it, expect } from 'vitest';
import { buildEnvelope, isReportableAbsence, absenceLabel } from '../../src/envelope.js';
import type { SourceStatus } from '../../src/core/budget.js';

const ok: SourceStatus = { status: 'ok', ms: 12, cache: 'hit' };
const timeout: SourceStatus = { status: 'timeout', ms: 12_000, cache: 'none' };

describe('absence semantics', () => {
  it('only an ok status makes an empty section reportable', () => {
    expect(isReportableAbsence(ok)).toBe(true);
    expect(isReportableAbsence(timeout)).toBe(false);
    expect(isReportableAbsence({ status: 'circuit_open', ms: 0, cache: 'none' })).toBe(false);
    expect(isReportableAbsence({ status: 'upstream_error', ms: 5, cache: 'none' })).toBe(false);
    expect(isReportableAbsence(undefined)).toBe(false);
  });

  it('phrases the two cases differently', () => {
    expect(absenceLabel('Written questions', ok)).toBe('No Written questions found in this window.');
    expect(absenceLabel('Written questions', timeout)).toMatch(/not evidence that none exist/);
  });
});

describe('envelope', () => {
  it('carries request id, status and build metadata', () => {
    const env = buildEnvelope({ a: 1 }, [], {
      requestId: 'REQ123',
      statuses: { bills: ok },
      partial: false,
    });
    expect(env.meta.request_id).toBe('REQ123');
    expect(env.meta.partial).toBe(false);
    expect(env.meta.sources_status.bills?.status).toBe('ok');
    expect(env.meta.engine.version).toBeTruthy();
    // The engine this replaces hard-coded 0.0.0, making deployments unidentifiable.
    expect(env.meta.engine.version).not.toBe('0.0.0');
  });

  it('deduplicates sources and drops ones without a url', () => {
    const env = buildEnvelope({}, [
      { title: 'A', url: 'https://x/1' },
      { title: 'A again', url: 'https://x/1' },
      { title: 'B', url: 'https://x/2' },
    ], { requestId: 'R', statuses: {}, partial: false });
    expect(env.sources).toHaveLength(2);
  });

  it('omits warnings when nothing degraded', () => {
    const env = buildEnvelope({}, [], { requestId: 'R', statuses: {}, partial: false, warnings: [] });
    expect(env.meta.warnings).toBeUndefined();
  });
});
