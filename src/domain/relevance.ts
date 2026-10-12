/**
 * Relevance scoring.
 *
 * Parliament's own search is weak — querying the written-questions API directly
 * with "climate change" returns NHS waiting-list questions, with no MCP in the
 * path. We cannot fix their index, so we rank what they return.
 *
 * The bug this replaces: the previous engine matched a petition when ANY topic
 * word of 4+ characters appeared anywhere in it. For "climate change" that made
 * "change" a match, which pulled in surrogacy law and school-attendance fines.
 */
const STOPWORDS = new Set([
  // general English
  'the','a','an','and','or','of','to','in','on','for','with','by','at','from','as','is','are',
  'be','been','it','its','that','this','these','those','their','there','which','what','how',
  'about','into','over','under','than','then','they','them','we','our','you','your','he','she',
  'his','her','not','no','all','any','can','will','would','should','could','may','might','must',
  'do','does','did','has','have','had','was','were','also','more','most','such','other','new',
  // parliamentary boilerplate — high frequency, near-zero discriminating power
  'bill','bills','act','acts','government','parliament','parliamentary','house','commons','lords',
  'draft','regulations','regulation','order','orders','secretary','state','minister','ministers',
  'department','committee','debate','question','questions','motion','amendment','clause','report',
  'uk','british','britain','england','scotland','wales',
]);

export const normalise = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, ' ');

const singular = (w: string): string =>
  w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y`
  : w.length > 3 && w.endsWith('ses') ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1)
  : w;

export function tokenise(s: string): string[] {
  return normalise(s)
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(singular)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Common policy words that survive stopword removal but carry little
 * discriminating power. "climate change" and "renters reform" each reduce to one
 * term that identifies the topic and one that appears almost everywhere.
 *
 * Requiring every term is too strict (it drops "briefing on climate and nature
 * risks"); requiring any is too loose (it was how "change" pulled surrogacy law
 * into a climate briefing). Splitting them gets both right without needing a
 * corpus to compute IDF against.
 */
const WEAK_TERMS = new Set([
  'change','changes','reform','reforms','policy','policies','support','funding','fund',
  'crisis','action','plan','plans','right','rights','care','service','system','scheme',
  'review','strategy','target','issue','impact','use','cost','access','safety','standard',
  'measure','provision','future','national','local','public','private','general',
]);

/** Terms that actually carry the query's meaning. Empty means "no usable signal". */
export function significantTerms(topic: string): string[] {
  return Array.from(new Set(tokenise(topic)));
}

/** Splits a query into the terms that must match and the ones that merely score. */
export function partitionTerms(topic: string): { core: string[]; weak: string[] } {
  const terms = significantTerms(topic);
  const core = terms.filter((t) => !WEAK_TERMS.has(t));
  const weak = terms.filter((t) => WEAK_TERMS.has(t));
  // A query made entirely of weak terms still has to match something.
  return core.length > 0 ? { core, weak } : { core: weak, weak: [] };
}

export interface ScoreOptions {
  /** Weight applied to title matches relative to body matches. */
  titleWeight?: number;
  /** Fraction of significant terms that must appear. 1 = all of them. */
  requireRatio?: number;
  /**
   * Require at least one significant term in the title.
   *
   * Long free-text bodies make term co-occurrence cheap: a petition about
   * reservoirs mentions "climate" and "change" in its background without being
   * about climate policy. Where the title is the item's actual subject, this
   * keeps the topic heading honest.
   */
  requireTitleHit?: boolean;
}

export interface Scored<T> {
  item: T;
  relevance: number;
}

const wordBoundaryHit = (haystackTokens: Set<string>, term: string): boolean => haystackTokens.has(term);

/**
 * Scores one candidate. Requires a configurable share of the query's significant
 * terms to be present — matching on ANY single term is what produced the
 * surrogacy-in-a-climate-briefing bug, so the default demands all of them.
 */
export function scoreOne(
  topic: string,
  title: string,
  body = '',
  opts: ScoreOptions = {},
): number {
  const titleWeight = opts.titleWeight ?? 3;
  const requireRatio = opts.requireRatio ?? 1;

  const { core, weak } = partitionTerms(topic);
  if (core.length === 0) return 0;

  const titleTokens = new Set(tokenise(title));
  const bodyTokens = new Set(tokenise(body));

  let coreMatched = 0;
  let titleHits = 0;
  let score = 0;

  for (const term of core) {
    const inTitle = wordBoundaryHit(titleTokens, term);
    const inBody = wordBoundaryHit(bodyTokens, term);
    if (inTitle || inBody) coreMatched += 1;
    if (inTitle) {
      titleHits += 1;
      score += titleWeight;
    } else if (inBody) score += 1;
  }

  // Weak terms never gate a match; they only break ties between candidates that
  // already carry the topic.
  for (const term of weak) {
    if (wordBoundaryHit(titleTokens, term)) score += 1;
    else if (wordBoundaryHit(bodyTokens, term)) score += 0.25;
  }

  if (coreMatched / core.length < requireRatio) return 0;
  if (opts.requireTitleHit && titleHits === 0) return 0;

  // Exact phrase in the title is the strongest signal available.
  const phrase = normalise(topic).trim();
  if (phrase && normalise(title).includes(phrase)) score += titleWeight * 2;

  return score;
}

/** Filters to genuine matches and sorts by relevance, highest first. */
export function rank<T>(
  topic: string,
  items: T[],
  project: (item: T) => { title: string; body?: string },
  opts: ScoreOptions = {},
): Scored<T>[] {
  return items
    .map((item) => {
      const { title, body } = project(item);
      return { item, relevance: scoreOne(topic, title, body ?? '', opts) };
    })
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance);
}
