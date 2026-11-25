// src/injector.mjs
// Three-channel prompt-injection compiler. Keeps hard constraints walled off
// from general context so the two injection channels never "fight":
//
//   channel 1: compiled_constraints — short, high-authority rules, injected
//              into the SYSTEM constraint region. Capped at 3 items x 30
//              chars so it can never balloon into a second context dump.
//   channel 2: context_claims       — decisions / api_shape / todo, injected
//              into dynamic context ONLY when they match current scope.
//   channel 3: pitfall_warnings     — pitfalls matching current file/tool,
//              surfaced with high priority ahead of channel 2 items.
//
// Every call returns a debugTrace with per-claim score breakdowns and the
// character/token savings vs. dumping the full claim set verbatim.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallClaims } from './recall.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _policyCache = null;
async function loadPolicy() {
  if (_policyCache) return _policyCache;
  const raw = await readFile(path.join(__dirname, 'memory_policy.json'), 'utf8');
  _policyCache = JSON.parse(raw);
  return _policyCache;
}

function estimateTokens(text) {
  // Rough, dependency-free heuristic: ~4 chars per token (English-ish code/text mix).
  return Math.ceil((text || '').length / 4);
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function authorityRank(a) {
  return { user_explicit: 3, tool_verified: 2, agent_inferred: 1 }[a] ?? 0;
}

/**
 * compilePromptInjection(ctx, { store, namespace, topK })
 * ctx: { taskText, activeFiles, activeModules, toolName }
 */
export async function compilePromptInjection(ctx, { store, namespace = 'default', topK } = {}) {
  const policy = await loadPolicy();
  const effectiveTopK = topK || policy.recall_defaults.topK;

  const recall = await recallClaims(ctx, { store, namespace, topK: Math.max(effectiveTopK, 12) });

  const allClaims = await store.listClaims(namespace, (c) => c.status === 'active' || c.status === 'disputed');

  // --- Channel 1: compiled_constraints ---
  const constraintPolicy = policy.channels.compiled_constraints;
  const minAuthorityRank = authorityRank(constraintPolicy.min_authority);
  const constraintCandidates = recall.results
    .filter((r) => r.claim.kind === 'constraint')
    .filter(
      (r) =>
        authorityRank(r.claim.authority) >= minAuthorityRank && r.claim.confidence >= constraintPolicy.min_confidence
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, constraintPolicy.max_items);

  const compiledConstraints = constraintCandidates.map((r) => truncate(r.claim.claim, constraintPolicy.max_chars_per_item));

  // --- Channel 3: pitfall_warnings (computed before channel 2 so it can take priority) ---
  const pitfallPolicy = policy.channels.pitfall_warnings;
  const pitfallCandidates = recall.results
    .filter((r) => r.claim.kind === 'pitfall')
    .sort((a, b) => b.score - a.score)
    .slice(0, pitfallPolicy.max_items);

  const pitfallWarnings = pitfallCandidates.map((r) => ({
    block_id: r.claim.block_id,
    text: r.claim.claim,
    source_ref: r.claim.source.ref,
    status: r.claim.status,
  }));

  // --- Channel 2: context_claims ---
  const contextPolicy = policy.channels.context_claims;
  const usedIds = new Set([...constraintCandidates, ...pitfallCandidates].map((r) => r.claim.block_id));
  const contextCandidates = recall.results
    .filter((r) => contextPolicy.eligible_kinds.includes(r.claim.kind) && !usedIds.has(r.claim.block_id))
    .sort((a, b) => b.score - a.score)
    .slice(0, contextPolicy.max_items);

  const contextClaims = contextCandidates.map((r) => ({
    block_id: r.claim.block_id,
    text: `[#${r.claim.block_id} | ${r.claim.authority} | ${r.claim.source.ref}] ${r.claim.claim}`,
    status: r.claim.status,
  }));

  // --- disputed warnings surfaced separately, never silently merged into channel 2 ---
  const disputedWarnings = recall.disputedWarnings;

  // --- token savings estimate: compiled output vs. dumping ALL active+disputed claims verbatim ---
  const compiledText = [
    ...compiledConstraints,
    ...pitfallWarnings.map((p) => p.text),
    ...contextClaims.map((c) => c.text),
  ].join('\n');

  const fullDumpText = allClaims.map((c) => JSON.stringify(c)).join('\n');

  const compiledChars = compiledText.length;
  const fullChars = fullDumpText.length || 1; // avoid div-by-zero when store is empty
  const compiledTokens = estimateTokens(compiledText);
  const fullTokens = estimateTokens(fullDumpText) || 1;

  const savings = {
    full_chars: fullChars,
    compiled_chars: compiledChars,
    char_savings_ratio: 1 - compiledChars / fullChars,
    full_tokens_est: fullTokens,
    compiled_tokens_est: compiledTokens,
    token_savings_ratio: 1 - compiledTokens / fullTokens,
  };

  const debugTrace = {
    recall_total_candidates: recall.totalCandidates,
    recall_matched_candidates: recall.matchedCandidates,
    scored: recall.results.map((r) => ({
      block_id: r.claim.block_id,
      kind: r.claim.kind,
      status: r.claim.status,
      score: r.score,
      breakdown: r.breakdown,
    })),
    channel_assignment: {
      compiled_constraints: constraintCandidates.map((r) => r.claim.block_id),
      pitfall_warnings: pitfallCandidates.map((r) => r.claim.block_id),
      context_claims: contextCandidates.map((r) => r.claim.block_id),
    },
    savings,
  };

  return {
    compiled_constraints: compiledConstraints,
    context_claims: contextClaims,
    pitfall_warnings: pitfallWarnings,
    disputed_warnings: disputedWarnings,
    debugTrace,
  };
}
