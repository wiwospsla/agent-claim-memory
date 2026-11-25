// src/stream_verdict.mjs
// Top-level "stream -> user" convergence: translates the four compaction-flow
// metrics plus live ledger state into exactly one of four plain-language
// global verdicts, with a one-sentence human summary and suggested actions.
//
//   healthy          — steady progress, stay quiet.
//   drifting          — repeated disputes/stalls piling up, ask the user to arbitrate.
//   regret_alert      — a compaction just cost a real failure; surface the lost claim.
//   ready_to_promote  — a claim has survived repeated verification with no
//                        counter-evidence; offer to promote it to a permanent rule.

import { evaluateCompactionFlow } from './compaction_flow.mjs';

const PROMOTE_MIN_CONFIDENCE = 0.9;
const PROMOTE_MIN_VERIFY_DELTA_EVENTS = 2; // at least 2 positive verify ledger entries, 0 fails since

function recentRegretEvents(compactions) {
  return compactions.filter((c) => c.type === 'compaction' && (c.regrets || []).length > 0);
}

function findPromotionCandidates(claims) {
  return claims.filter((c) => {
    if (c.status !== 'active') return false;
    if (c.confidence < PROMOTE_MIN_CONFIDENCE) return false;
    const verifyEvents = (c.weight_ledger || []).filter((e) => e.action === 'verify_ok' || e.action === 'verify_fail');
    if (!verifyEvents.length) return false;
    const lastFailIdx = verifyEvents.map((e) => e.action).lastIndexOf('verify_fail');
    const okAfterLastFail = verifyEvents.slice(lastFailIdx + 1).filter((e) => e.action === 'verify_ok');
    return lastFailIdx === -1
      ? verifyEvents.filter((e) => e.action === 'verify_ok').length >= PROMOTE_MIN_VERIFY_DELTA_EVENTS
      : okAfterLastFail.length >= PROMOTE_MIN_VERIFY_DELTA_EVENTS;
  });
}

/**
 * getVerdict({ store, namespace }): compute the global verdict.
 */
export async function getVerdict({ store, namespace = 'default' } = {}) {
  const flow = await evaluateCompactionFlow({ store, namespace });
  const compactions = await store.listCompactions(namespace);
  const allClaims = await store.listClaims(namespace, () => true);

  const regretEvents = recentRegretEvents(compactions);
  const latestRegret = regretEvents[regretEvents.length - 1];

  const disputedClaims = allClaims.filter((c) => c.status === 'disputed');
  const promotionCandidates = findPromotionCandidates(allClaims);

  // Priority order: regret_alert > drifting > ready_to_promote > healthy.
  // A fresh regret is the most actionable/urgent signal; drifting (systemic
  // dispute buildup) outranks a "nice to have" promotion offer.
  if (latestRegret) {
    const lostIds = (latestRegret.regrets || []).flatMap((r) => r.lost_claim_ids || []);
    const lostDetails = (latestRegret.lost_claims || []).filter((lc) => lostIds.includes(lc.block_id));
    return {
      state: 'regret_alert',
      headline: `压缩在第 ${latestRegret.round_at} 轮丢掉的结论随后被证伪，返工代价已产生，立即恢复相关结论。`,
      suggested_actions: [
        '将被丢结论重新置顶召回（已自动满足 scope 命中即救回）',
        '核查该压缩摘要模板是否系统性漏掉同类 constraint/decision',
        ...lostDetails.map((lc) => `复核结论 #${lc.block_id}: "${lc.claim}" (来源 ${lc.source_ref})`),
      ],
      evidence: { regret_event: latestRegret, flow },
    };
  }

  if (disputedClaims.length >= 2 || flow.trust_score < 0.6) {
    return {
      state: 'drifting',
      headline: `存在 ${disputedClaims.length} 条争议结论或压缩可信度偏低 (trust_score=${flow.trust_score})，建议人工仲裁。`,
      suggested_actions: [
        '逐条审查 disputed 结论的双方证据',
        '对关键结论调用 restoreClaim 选择 replace_current 或 mark_disputed 定案',
        '避免在该作用域继续自动决策，等待人工裁决',
      ],
      evidence: { disputed: disputedClaims.map((c) => c.block_id), flow },
    };
  }

  if (promotionCandidates.length > 0) {
    return {
      state: 'ready_to_promote',
      headline: `${promotionCandidates.length} 条结论已多次验证通过且无反例，建议固化为永久规范。`,
      suggested_actions: promotionCandidates.map(
        (c) => `是否将 #${c.block_id} ("${c.claim}") 升格为 constraint 并置顶?`
      ),
      evidence: { candidates: promotionCandidates.map((c) => c.block_id), flow },
    };
  }

  return {
    state: 'healthy',
    headline: '当前记忆流稳步推进，无争议堆积、无压缩后悔，无需人工介入。',
    suggested_actions: [],
    evidence: { flow },
  };
}

export { PROMOTE_MIN_CONFIDENCE, PROMOTE_MIN_VERIFY_DELTA_EVENTS };
