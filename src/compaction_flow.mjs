// src/compaction_flow.mjs
// Compaction-loss audit + four-metric flow evaluation.
//
// auditCompaction: diff the active claims that mattered at compaction time
// against the actual summary text, and record what got dropped.
//
// compaction_regret: retroactive causal link — if a claim that was dropped
// by a compaction later gets a failed verifyClaim() on an overlapping
// file/module within K rounds, we tie that failure back to the compaction
// event that lost it. This module records the regret entries; callers in
// adjudicator.verifyClaim should invoke `recordRegretIfApplicable` (exposed
// here) after a failed verification.
//
// evaluateCompactionFlow: rolls compaction events + regrets into four
// numbers: learning_index, weight_quota, trust_score, proficiency.

const DEFAULT_REGRET_WINDOW_ROUNDS = 10;

function tokenize(text) {
  return (text || '').toLowerCase().split(/[^a-z0-9_.\/-]+/).filter(Boolean);
}

function claimAppearsInSummary(claim, summaryTokens, summaryTextLower) {
  // A claim "survives" compaction if its key terms (claim text tokens) show
  // meaningful overlap with the summary, OR its block_id/source ref is
  // explicitly cited.
  if (claim.block_id && summaryTextLower.includes(claim.block_id.toLowerCase())) return true;
  const claimTokens = tokenize(claim.claim);
  if (!claimTokens.length) return false;
  const significant = claimTokens.filter((t) => t.length > 3);
  const base = significant.length ? significant : claimTokens;
  const hits = base.filter((t) => summaryTokens.includes(t));
  const ratio = hits.length / base.length;
  return ratio >= 0.5;
}

/**
 * auditCompaction(summaryText, { sessionRef, roundAt, activeFiles }, { store, namespace })
 * Returns the recorded compaction event (as persisted) including lost_claims.
 */
export async function auditCompaction(summaryText, { sessionRef, roundAt, activeFiles = [] } = {}, { store, namespace = 'default' } = {}) {
  if (typeof summaryText !== 'string') throw new Error('auditCompaction requires summaryText string');
  if (typeof roundAt !== 'number') throw new Error('auditCompaction requires numeric roundAt');

  const relevantClaims = await store.listClaims(namespace, (c) => {
    if (c.status !== 'active' && c.status !== 'disputed') return false;
    if (!activeFiles.length) return true;
    const files = c.scope.files || [];
    if (!files.length) return false; // global/background claims aren't "key" for this audit
    return files.some((f) => activeFiles.includes(f) || activeFiles.some((af) => af.startsWith(f) || f.startsWith(af)));
  });

  const summaryTokens = tokenize(summaryText);
  const summaryTextLower = summaryText.toLowerCase();

  const lostClaims = [];
  const keptClaims = [];
  for (const claim of relevantClaims) {
    if (claimAppearsInSummary(claim, summaryTokens, summaryTextLower)) {
      keptClaims.push(claim.block_id);
    } else {
      lostClaims.push({
        block_id: claim.block_id,
        kind: claim.kind,
        claim: claim.claim,
        scope: claim.scope,
        authority: claim.authority,
        confidence: claim.confidence,
        source_ref: claim.source.ref,
      });
    }
  }

  const event = {
    type: 'compaction',
    session_ref: sessionRef || null,
    round_at: roundAt,
    active_files: activeFiles,
    summary_excerpt: summaryText.slice(0, 400),
    key_claims_considered: relevantClaims.length,
    kept_claims: keptClaims,
    lost_claims: lostClaims,
    regrets: [],
  };

  return store.addCompactionEvent(namespace, event);
}

/**
 * recordRegretIfApplicable: call this after a verifyClaim(ok=false). Looks
 * back through compaction events for ones that (a) happened within the last
 * REGRET_WINDOW rounds relative to currentRound, and (b) lost a claim whose
 * scope overlaps the failed claim's scope. If found, appends a
 * compaction_regret entry to that compaction event (in place, via a fresh
 * transaction-safe read-modify-write through the store's public API).
 */
export async function recordRegretIfApplicable(
  failedClaim,
  { currentRound, windowRounds = DEFAULT_REGRET_WINDOW_ROUNDS } = {},
  { store, namespace = 'default' } = {}
) {
  const compactions = await store.listCompactions(namespace);
  const failedFiles = new Set(failedClaim.scope.files || []);
  const failedModules = new Set(failedClaim.scope.modules || []);

  const regrettedEvents = [];

  for (const event of compactions) {
    if (typeof currentRound === 'number') {
      const age = currentRound - event.round_at;
      if (age < 0 || age > windowRounds) continue;
    }
    const matchingLost = (event.lost_claims || []).filter((lc) => {
      const lcFiles = new Set(lc.scope?.files || []);
      const lcModules = new Set(lc.scope?.modules || []);
      const fileOverlap = [...lcFiles].some((f) => failedFiles.has(f));
      const modOverlap = [...lcModules].some((m) => failedModules.has(m));
      return fileOverlap || modOverlap || lc.block_id === failedClaim.block_id;
    });
    if (matchingLost.length) {
      regrettedEvents.push({ event, matchingLost });
    }
  }

  if (!regrettedEvents.length) return [];

  const recorded = [];
  await store.transaction(async (tx) => {
    for (const { event, matchingLost } of regrettedEvents) {
      const regretEntry = {
        at: new Date().toISOString(),
        failed_claim_id: failedClaim.block_id,
        failed_round: currentRound ?? null,
        lost_claim_ids: matchingLost.map((m) => m.block_id),
        note: 'A claim dropped by this compaction was later contradicted by a real failure in overlapping scope.',
      };
      tx.appendRegret(namespace, event.event_id, regretEntry);
      recorded.push(regretEntry);
    }
  });

  return recorded;
}

/**
 * evaluateCompactionFlow({ store, namespace }): four-metric diagnosis.
 *
 *  - learning_index: did progress stall after compactions? Approximated as
 *    1 - (regret_count / max(1, compaction_count)) scaled toward 0 when
 *    regrets cluster.
 *  - weight_quota: fraction of lost_claims that were NOT low-value kinds
 *    (constraint/pitfall/decision are high-value; losing them is worse).
 *  - trust_score: 1 - regret_rate (regret_rate = regretted compactions /
 *    total compactions).
 *  - proficiency: variance of per-compaction loss-rate across events (lower
 *    variance = more consistent compaction quality = higher proficiency).
 */
export async function evaluateCompactionFlow({ store, namespace = 'default' } = {}) {
  const compactions = (await store.listCompactions(namespace)).filter((c) => c.type === 'compaction');

  if (!compactions.length) {
    return {
      learning_index: 1,
      weight_quota: 1,
      trust_score: 1,
      proficiency: 1,
      compaction_count: 0,
      regret_count: 0,
      detail: 'no compaction events recorded yet',
    };
  }

  let totalLost = 0;
  let highValueLost = 0;
  let totalConsidered = 0;
  let regretCount = 0;
  const lossRates = [];

  for (const event of compactions) {
    const lost = event.lost_claims || [];
    const considered = event.key_claims_considered || (lost.length + (event.kept_claims || []).length) || 1;
    totalLost += lost.length;
    totalConsidered += considered;
    highValueLost += lost.filter((lc) => ['constraint', 'pitfall', 'decision'].includes(lc.kind)).length;
    if ((event.regrets || []).length > 0) regretCount += 1;
    lossRates.push(lost.length / considered);
  }

  const regretRate = regretCount / compactions.length;
  const trustScore = Math.max(0, 1 - regretRate);

  const highValueLossRatio = totalLost > 0 ? highValueLost / totalLost : 0;
  const weightQuota = Math.max(0, 1 - highValueLossRatio);

  const learningIndex = Math.max(0, 1 - regretRate * 1.2);

  const meanLossRate = lossRates.reduce((a, b) => a + b, 0) / lossRates.length;
  const variance =
    lossRates.reduce((acc, r) => acc + (r - meanLossRate) ** 2, 0) / lossRates.length;
  const proficiency = Math.max(0, 1 - Math.min(1, variance * 4));

  return {
    learning_index: round2(learningIndex),
    weight_quota: round2(weightQuota),
    trust_score: round2(trustScore),
    proficiency: round2(proficiency),
    compaction_count: compactions.length,
    regret_count: regretCount,
    total_lost_claims: totalLost,
    high_value_lost_claims: highValueLost,
    mean_loss_rate: round2(meanLossRate),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
