import { describe, it, expect } from 'vitest';
import { scoreOne, rank, significantTerms, partitionTerms } from '../../src/domain/relevance.js';

/**
 * Regression for the bug that put surrogacy law and school-attendance fines into
 * a climate-change briefing: the previous engine matched a petition if ANY topic
 * word of 4+ characters appeared in it, and "change" appears everywhere.
 */
describe('petition relevance — the "change" bug', () => {
  const petitions = [
    { action: 'Legislate to ban FPNs and prosecutions related to school attendance', background: 'Parents face fines and prosecution; we want this changed.' },
    { action: 'Hold a UK-wide briefing on climate and nature risks', background: 'Climate change and nature loss pose systemic risks.' },
    { action: 'Change surrogacy law to recognise intended parents from birth', background: 'The current law requires a parental order.' },
  ];

  it('excludes petitions that only share the word "change"', () => {
    const hits = rank('climate change', petitions, (p) => ({ title: p.action, body: p.background }));
    const actions = hits.map((h) => h.item.action);

    expect(actions).toContain('Hold a UK-wide briefing on climate and nature risks');
    expect(actions).not.toContain('Change surrogacy law to recognise intended parents from birth');
    expect(actions).not.toContain('Legislate to ban FPNs and prosecutions related to school attendance');
    expect(hits).toHaveLength(1);
  });

  it('requires all significant terms, not just one', () => {
    expect(scoreOne('climate change', 'Change of use planning reform')).toBe(0);
    expect(scoreOne('climate change', 'Climate change adaptation')).toBeGreaterThan(0);
  });

  it('drops parliamentary boilerplate from the query', () => {
    // "bill" and "act" carry no discriminating power in this corpus.
    expect(significantTerms('the Climate Change Act 2008')).toEqual(['climate', 'change', '2008']);
    expect(significantTerms('Government Bill')).toEqual([]);
  });

  it('gates on the discriminating term, not the common one', () => {
    const { core, weak } = partitionTerms('climate change');
    expect(core).toEqual(['climate']);
    expect(weak).toEqual(['change']);

    // "climate" alone identifies the topic; "change" alone does not.
    expect(scoreOne('climate change', 'Climate and nature risks briefing')).toBeGreaterThan(0);
    expect(scoreOne('climate change', 'Change surrogacy law')).toBe(0);
  });

  it('still requires every term when all of them discriminate', () => {
    expect(partitionTerms('NHS waiting lists').core).toEqual(['nhs', 'waiting', 'list']);
    expect(scoreOne('NHS waiting lists', 'NHS waiting list reporting')).toBeGreaterThan(0);
    expect(scoreOne('NHS waiting lists', 'NHS dentistry access')).toBe(0);
  });

  it('ranks a full-phrase match above a core-only match', () => {
    const both = scoreOne('climate change', 'Climate change adaptation');
    const coreOnly = scoreOne('climate change', 'Climate and nature risks');
    expect(both).toBeGreaterThan(coreOnly);
  });

  it('gives no signal rather than matching everything when the query is all stopwords', () => {
    expect(scoreOne('the government bill', 'Anything at all')).toBe(0);
  });

  it('ranks a title match above a body-only match', () => {
    const titleHit = scoreOne('renters reform', 'Renters reform: second reading');
    const bodyHit = scoreOne('renters reform', 'Housing debate', 'A discussion of renters reform proposals');
    expect(titleHit).toBeGreaterThan(bodyHit);
  });

  it('matches on word boundaries, not substrings', () => {
    // "car" must not match "carbon"; the old implementation used includes().
    expect(scoreOne('car', 'Carbon capture and storage')).toBe(0);
  });

  it('handles plurals', () => {
    expect(scoreOne('renters reform', 'Renter reforms debated')).toBeGreaterThan(0);
  });
});

describe('requireTitleHit', () => {
  it('rejects an item whose topic terms appear only in the body', () => {
    // A reservoir petition mentions "climate" and "change" in its background
    // without being about climate policy.
    const title = 'Fund new reservoirs to increase future water supplies';
    const body = 'Water security matters as the climate continues to change rapidly.';
    expect(scoreOne('climate change', title, body)).toBeGreaterThan(0);
    expect(scoreOne('climate change', title, body, { requireTitleHit: true })).toBe(0);
  });

  it('keeps an item whose title carries the topic', () => {
    expect(
      scoreOne('climate change', 'Hold a UK-wide briefing on climate and nature risks',
        'Climate change and nature loss pose systemic risks.', { requireTitleHit: true }),
    ).toBeGreaterThan(0);
  });
});
