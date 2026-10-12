import { describe, it, expect } from 'vitest';
import { splitTopicAndWindow, windowFor, withinWindow } from '../../src/domain/dates.js';

/**
 * Regression for the silent-empty-briefing case: passing the user's whole phrase
 * as the topic matched no titles, and the tool reported that Parliament had done
 * nothing about climate change.
 */
describe('topic and window splitting', () => {
  it('strips a trailing date phrase and infers the window', () => {
    expect(splitTopicAndWindow('climate change last 90 days')).toEqual({
      topic: 'climate change',
      lookbackDays: 90,
    });
  });

  it('converts units', () => {
    expect(splitTopicAndWindow('AI policy last 6 months').lookbackDays).toBe(180);
    expect(splitTopicAndWindow('renters reform past 2 weeks').lookbackDays).toBe(14);
  });

  it('clamps beyond the upstream maximum', () => {
    expect(splitTopicAndWindow('housing last 10 years').lookbackDays).toBe(365);
  });

  it('leaves a clean topic untouched', () => {
    expect(splitTopicAndWindow('climate change')).toEqual({ topic: 'climate change' });
  });

  it('never reduces a topic to nothing', () => {
    const out = splitTopicAndWindow('last 90 days');
    expect(out.topic.length).toBeGreaterThan(1);
  });
});

describe('window arithmetic', () => {
  it('computes an inclusive ISO window', () => {
    const w = windowFor(90, new Date('2026-08-27T12:00:00Z'));
    expect(w).toEqual({ from: '2026-05-29', to: '2026-08-27' });
  });

  it('detects dates outside the window', () => {
    const w = windowFor(90, new Date('2026-08-27T12:00:00Z'));
    expect(withinWindow('2026-06-24T19:59:00', w)).toBe(true);
    // The 2016 and 2021 divisions the old engine listed as "recent".
    expect(withinWindow('2016-07-20T00:00:00', w)).toBe(false);
    expect(withinWindow('2021-06-16T00:00:00', w)).toBe(false);
    expect(withinWindow(null, w)).toBe(false);
  });
});
