// src/recall.mjs
// Scope-filtered, four-dimensional recall: scope x authority x confidence x
// status, with a real IDF-weighted BM25 term for text relevance.
// Deliberately NO time-decay term — a decision made 90 days ago is exactly
// as retrievable as one made an hour ago, as long as it is still 'active'
// (or 'disputed', surfaced with a warning).

const AUTHORITY_WEIGHT = {
  user_explicit: 1.0,
  tool_verified: 0.85,
  agent_inferred: 0.55,
};

const STATUS_WEIGHT = {
  active: 1.0,
  disputed: 0.7, // still surfaced, but discounted + flagged
  unverified: 0.5,
  superseded: 0.0, // excluded by default (see includeSuperseded)
  archived: 0.0,
};

// BM25 constants (standard Robertson/Sparck-Jones defaults).
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Guard against pathological/adversarial input blowing up tokenization or
// scoring cost: cap how much text we ever tokenize per field.
const MAX_QUERY_CHARS = 4000;
const MAX_CLAIM_CHARS = 4000;
const MAX_TOKENS = 512;

function tokenize(text, maxChars = MAX_QUERY_CHARS) {
  const bounded = (text || '').slice(0, maxChars);
  const tokens = bounded
    .toLowerCase()
    .split(/[^a-z0-9_.\/-]+/)
    .filter(Boolean);
  return tokens.length > MAX_TOKENS ? tokens.slice(0, MAX_TOKENS) : tokens;
}

/**
 * Build corpus-wide document-frequency stats for real IDF, over whatever
 * claim set is being searched (the live namespace corpus — this is
 * recomputed per recall call since the corpus changes as claims are
 * added/superseded; namespaces are small enough that this is cheap and it
 * guarantees IDF always reflects the CURRENT working set, not a stale
 * snapshot).
 */
function buildCorpusStats(claims) {
  const df = new Map(); // term -> number of claims containing it
  let totalLength = 0;
  const docTokens = new Map(); // block_id -> tokens (cached so scoring doesn't retokenize)

  for (const claim of claims) {
    const tokens = tokenize(claim.claim, MAX_CLAIM_CHARS);
    docTokens.set(claim.block_id, tokens);
    totalLength += tokens.length;
    const seen = new Set(tokens);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const n = claims.length || 1;
  const avgDocLength = totalLength / n || 1;

  return { df, n, avgDocLength, docTokens };
}

function idf(term, corpusStats) {
  const df = corpusStats.df.get(term) || 0;
  const n = corpusStats.n;
  // Standard BM25 IDF with +1 smoothing so a term appearing in every claim
  // still gets a small positive weight instead of going negative/zero, and
  // a term unseen in the corpus (but present in the query) still contributes
  // a sensible "informative because it's rare/novel" weight.
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/**
 * Real BM25 score for one claim's text against the query, using IDF derived
 * from the live corpus. High-frequency filler words ("file", "modify",
 * "code") naturally end up with low IDF and contribute little; a rare,
 * specific anchor term (an error code, an exact API name) that appears in
 * only one claim gets a much higher IDF weight and dominates the score.
 */
function bm25Score(queryTokens, claimTokens, corpusStats) {
  if (!queryTokens.length || !claimTokens.length) return 0;
  const termFreq = new Map();
  for (const t of claimTokens) termFreq.set(t, (termFreq.get(t) || 0) + 1);

  const docLength = claimTokens.length;
  const avgDocLength = corpusStats.avgDocLength;

  let score = 0;
  const queryTermSet = new Set(queryTokens);
  for (const term of queryTermSet) {
    const tf = termFreq.get(term) || 0;
    if (tf === 0) continue;
    const idfWeight = idf(term, corpusStats);
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
    score += idfWeight * (numerator / denominator);
  }
  return score;
}

function scopeMatchScore(claimScope, ctx) {
  const files = new Set(claimScope.files || []);
  const modules = new Set(claimScope.modules || []);
  const tags = new Set(claimScope.tags || []);

  const activeFiles = ctx.activeFiles || [];
  const activeModules = ctx.activeModules || [];
  const taskTokens = tokenize(ctx.taskText);

  let score = 0;
  let matched = false;

  for (const f of activeFiles) {
    if (files.has(f)) {
      score += 1.0;
      matched = true;
    } else if ([...files].some((sf) => f.startsWith(sf) || sf.startsWith(f))) {
      score += 0.6;
      matched = true;
    }
  }
  for (const m of activeModules) {
    if (modules.has(m)) {
      score += 0.8;
      matched = true;
    }
  }
  for (const tag of tags) {
    if (taskTokens.includes(tag.toLowerCase())) {
      score += 0.5;
      matched = true;
    }
  }
  if (ctx.toolName && tags.has(ctx.toolName)) {
    score += 0.4;
    matched = true;
  }

  // Claims with totally empty scope (no files/modules/tags) are treated as
  // globally-relevant but low-priority background knowledge.
  if (!files.size && !modules.size && !tags.size) {
    return { score: 0.15, matched: true, global: true };
  }

  return { score: Math.min(score, 2.5), matched, global: false };
}

function cooldownFactor() {
  // Explicitly constant: this system has no time-based forgetting. The hook
  // stays named "cooldown_factor" per spec but always resolves to 1 so the
  // formula is self-documenting about what it deliberately does NOT do.
  return 1;
}

/**
 * Score one claim against a recall context. Returns null if the claim is
 * out of scope entirely so callers can filter it.
 *
 * corpusStats is optional: if omitted, a single-document corpus is built
 * on the fly (used by callers scoring one claim in isolation, e.g. tests).
 * recallClaims() always supplies the full live-namespace corpusStats so
 * IDF reflects the real working set.
 */
export function scoreClaim(claim, ctx, corpusStats) {
  if (claim.status === 'superseded' || claim.status === 'archived') return null;

  const scope = scopeMatchScore(claim.scope, ctx);
  if (!scope.matched) return null;

  const stats = corpusStats || buildCorpusStats([claim]);
  const queryTokens = tokenize(ctx.taskText);
  const claimTokens = stats.docTokens.get(claim.block_id) || tokenize(claim.claim, MAX_CLAIM_CHARS);
  const bm25Raw = bm25Score(queryTokens, claimTokens, stats);
  // Normalize into a roughly 0..1-ish band so it composes predictably with
  // the other multiplicative factors (BM25 is otherwise unbounded above).
  const bm25 = bm25Raw / (bm25Raw + 2);

  const authorityWeight = AUTHORITY_WEIGHT[claim.authority] ?? 0.5;
  const statusWeight = STATUS_WEIGHT[claim.status] ?? 0.3;
  const cooldown = cooldownFactor();

  const baseScore =
    (scope.score * 0.4 + bm25 * 0.6 + 0.05) * authorityWeight * claim.confidence * claim.utility * statusWeight * cooldown;

  return {
    claim,
    score: baseScore,
    breakdown: {
      scope_match: scope.score,
      bm25,
      bm25_raw: bm25Raw,
      authority_weight: authorityWeight,
      confidence: claim.confidence,
      utility: claim.utility,
      status_weight: statusWeight,
      cooldown_factor: cooldown,
      global_fallback: scope.global,
    },
  };
}

/**
 * recallClaims({ taskText, activeFiles, activeModules, toolName }, { store, namespace, topK })
 */
export async function recallClaims(ctx, { store, namespace = 'default', topK = 5 } = {}) {
  const claims = await store.listClaims(namespace, (c) => c.status !== 'archived');
  const corpusStats = buildCorpusStats(claims);

  const scored = [];
  for (const claim of claims) {
    const s = scoreClaim(claim, ctx, corpusStats);
    if (s) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  const disputedWarnings = top
    .filter((s) => s.claim.status === 'disputed')
    .map((s) => ({
      block_id: s.claim.block_id,
      claim: s.claim.claim,
      warning: 'DISPUTED: conflicting evidence exists — do not treat as settled; see ledger before acting.',
    }));

  return {
    results: top,
    disputedWarnings,
    totalCandidates: claims.length,
    matchedCandidates: scored.length,
  };
}
