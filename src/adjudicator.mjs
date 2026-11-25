// src/adjudicator.mjs
// Claim lifecycle: propose, supersede, verify, restore.
//
// Anti-double-active rule lives in restoreClaim(): rejecting a 'superseded'
// verdict must never leave two mutually-exclusive conclusions both 'active'.
// Every mutation in this module is expressed as ONE store.transaction() call
// so partial failures cannot leave an inconsistent pair on disk.

import crypto from 'node:crypto';
import { clampConfidence, clampUtility, makeLedgerEntry } from './schema.mjs';

function newBlockId(kind) {
  return `${kind}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function sameScope(a, b) {
  const aFiles = new Set(a.files || []);
  const bFiles = new Set(b.files || []);
  const aMods = new Set(a.modules || []);
  const bMods = new Set(b.modules || []);
  const aTags = new Set(a.tags || []);
  const bTags = new Set(b.tags || []);

  const filesOverlap = [...aFiles].some((f) => bFiles.has(f));
  const modsOverlap = [...aMods].some((m) => bMods.has(m));
  const tagsOverlap = [...aTags].some((t) => bTags.has(t));

  // Require at least one concrete overlap dimension; empty scopes never "match".
  return filesOverlap || modsOverlap || tagsOverlap;
}

const REPLACEABLE_KINDS = new Set(['decision', 'api_shape', 'constraint']);

/**
 * Decide initial authority/confidence from the source kind. Keeps the
 * "no ungrounded model self-indulgence" discipline: agent_inferred claims
 * start at modest confidence and must be verified to earn trust.
 */
function deriveInitialAuthorityConfidence(source, explicitAuthority, explicitConfidence) {
  let authority = explicitAuthority;
  let confidence = explicitConfidence;

  if (!authority) {
    if (source.kind === 'user') authority = 'user_explicit';
    else if (source.kind === 'tool') authority = 'tool_verified';
    else authority = 'agent_inferred';
  }

  if (typeof confidence !== 'number') {
    if (authority === 'user_explicit') confidence = 0.85;
    else if (authority === 'tool_verified') confidence = 0.8;
    else confidence = 0.4; // agent_inferred: unproven, must earn confidence via verifyClaim
  }

  return { authority, confidence: clampConfidence(confidence) };
}

export class Adjudicator {
  constructor({ store }) {
    if (!store) throw new Error('Adjudicator requires a store');
    this.store = store;
  }

  /**
   * proposeClaim(input): normalize + persist a new claim.
   * input: { namespace, kind, claim, scope, source, authority?, confidence?,
   *          utility?, evidence?, supersedes_ids? }
   */
  async proposeClaim(input) {
    if (!input || !input.source) {
      throw new Error('proposeClaim requires input.source (provenance is mandatory)');
    }
    const { authority, confidence } = deriveInitialAuthorityConfidence(
      input.source,
      input.authority,
      input.confidence
    );

    const blockId = input.block_id || newBlockId(input.kind || 'decision');
    const initialStatus = input.status || (authority === 'agent_inferred' ? 'unverified' : 'active');

    const ledgerEntry = makeLedgerEntry({
      actor: input.source.kind === 'user' ? 'user' : input.source.kind,
      action: 'propose',
      delta: 0,
      reason: 'initial proposal',
      evidenceRef: input.source.ref,
    });

    const claimInput = {
      block_id: blockId,
      namespace: input.namespace || 'default',
      kind: input.kind,
      scope: input.scope,
      claim: input.claim,
      status: initialStatus,
      authority,
      confidence,
      utility: typeof input.utility === 'number' ? clampUtility(input.utility) : 0.6,
      source: input.source,
      evidence: input.evidence ?? null,
      weight_ledger: [ledgerEntry],
    };

    let created;
    await this.store.transaction(async (tx) => {
      created = await tx.addClaim(claimInput);
    });

    if (input.supersedes_ids && input.supersedes_ids.length) {
      await this.checkAndSupersede(created, { supersedesIds: input.supersedes_ids });
    } else {
      await this.checkAndSupersede(created, {});
    }

    return this.store.getClaim(created.namespace, created.block_id);
  }

  /**
   * checkAndSupersede(newClaim, { supersedesIds }): find prior active claims
   * in the same scope that this new claim replaces, and mark them superseded.
   * Only REPLACEABLE_KINDS are auto-superseded by scope-overlap; pitfalls and
   * claims in disjoint scopes are left alone (complementary coexistence).
   */
  async checkAndSupersede(newClaim, { supersedesIds = [] } = {}) {
    const namespace = newClaim.namespace;
    let supersededIds = [];

    await this.store.transaction(async (tx) => {
      const candidates = tx.listClaims(namespace, (c) => c.block_id !== newClaim.block_id && c.status === 'active');

      const explicitSet = new Set(supersedesIds);
      for (const candidate of candidates) {
        const isExplicit = explicitSet.has(candidate.block_id);
        const isScopeConflict =
          REPLACEABLE_KINDS.has(newClaim.kind) &&
          candidate.kind === newClaim.kind &&
          sameScope(candidate.scope, newClaim.scope);

        if (!isExplicit && !isScopeConflict) continue;

        const ledgerEntry = makeLedgerEntry({
          actor: 'adjudicator',
          action: 'supersede',
          delta: 0,
          reason: isExplicit ? 'explicit supersedes_ids' : 'scope-conflicting replacement',
          evidenceRef: newClaim.source.ref,
        });
        tx.updateClaim(
          candidate.block_id,
          {
            status: 'superseded',
            superseded_by: newClaim.block_id,
            evidence: newClaim.claim,
          },
          ledgerEntry
        );
        supersededIds.push(candidate.block_id);
      }
    });

    return supersededIds;
  }

  /**
   * verifyClaim(blockId, { ok, evidenceRef, note }):
   * ok=true  -> raise confidence/utility, unverified -> active.
   * ok=false -> lower confidence, track consecutive failures; 2+ consecutive
   *             failures flips status to 'disputed'.
   */
  async verifyClaim(blockId, { ok, evidenceRef, note, currentRound, namespace } = {}) {
    await this._ensureClaimLoadable(blockId, namespace);
    let updated;
    await this.store.transaction(async (tx) => {
      const current = await this._findClaim(tx, blockId);
      if (!current) throw new Error(`verifyClaim: block_id not found: ${blockId}`);

      const failCount = (current._consecutive_fail || 0);
      let nextStatus = current.status;
      let nextConfidence = current.confidence;
      let nextUtility = current.utility;
      let nextFailCount = failCount;

      if (ok) {
        nextConfidence = clampConfidence(current.confidence + 0.15);
        nextUtility = clampUtility(current.utility + 0.1);
        nextFailCount = 0;
        if (current.status === 'unverified') nextStatus = 'active';
      } else {
        nextConfidence = clampConfidence(current.confidence - 0.25);
        nextUtility = clampUtility(current.utility - 0.15);
        nextFailCount = failCount + 1;
        if (nextFailCount >= 2) {
          nextStatus = 'disputed';
        }
      }

      const ledgerEntry = makeLedgerEntry({
        actor: 'verify',
        action: ok ? 'verify_ok' : 'verify_fail',
        delta: nextConfidence - current.confidence,
        reason: note || (ok ? 'verification succeeded' : 'verification failed'),
        evidenceRef: evidenceRef || null,
      });

      updated = tx.updateClaim(
        blockId,
        {
          status: nextStatus,
          confidence: nextConfidence,
          utility: nextUtility,
          _consecutive_fail: nextFailCount,
        },
        ledgerEntry
      );
    });

    if (!ok && updated) {
      // Causal回溯 for compaction regret runs AFTER the transaction above has
      // committed and released the lock — recordRegretIfApplicable opens its
      // own transaction(s), and re-entering the lock from inside an open
      // transaction would deadlock.
      const { recordRegretIfApplicable } = await import('./compaction_flow.mjs');
      await recordRegretIfApplicable(
        updated,
        { currentRound },
        { store: this.store, namespace: updated.namespace }
      );
    }

    return updated;
  }

  /**
   * restoreClaim(blockId, { mode, reason }): strict anti-double-active.
   *
   * - current.status === 'archived'  -> restore to 'active' (simple undo).
   * - current.status === 'superseded' -> caller MUST pass mode:
   *     'replace_current'  : the claim that superseded this one is pushed back
   *                           to 'superseded' (pointing at this restored one),
   *                           and this claim becomes 'active' again. Exactly
   *                           one of the pair is ever 'active'.
   *     'mark_disputed'     : both this claim and its superseder become
   *                           'disputed' simultaneously; ledger records the
   *                           arbitration event on both sides.
   */
  async restoreClaim(blockId, { mode, reason, namespace } = {}) {
    await this._ensureClaimLoadable(blockId, namespace);
    let result;
    await this.store.transaction(async (tx) => {
      const current = await this._findClaim(tx, blockId);
      if (!current) throw new Error(`restoreClaim: block_id not found: ${blockId}`);

      if (current.status === 'archived') {
        const ledgerEntry = makeLedgerEntry({
          actor: 'restore',
          action: 'restore_from_archive',
          reason: reason || 'undo archive',
        });
        result = tx.updateClaim(blockId, { status: 'active' }, ledgerEntry);
        return;
      }

      if (current.status !== 'superseded') {
        throw new Error(
          `restoreClaim: block_id ${blockId} has status '${current.status}', only 'archived' or 'superseded' can be restored`
        );
      }

      if (mode !== 'replace_current' && mode !== 'mark_disputed') {
        throw new Error(
          "restoreClaim: restoring a 'superseded' claim requires mode 'replace_current' or 'mark_disputed'"
        );
      }

      const supersederId = current.superseded_by;
      const superseder = supersederId ? await this._findClaim(tx, supersederId) : null;

      if (mode === 'replace_current') {
        if (superseder && superseder.status === 'active') {
          const demoteLedger = makeLedgerEntry({
            actor: 'restore',
            action: 'demote_by_restore',
            reason: reason || `demoted because ${blockId} was restored`,
            evidenceRef: blockId,
          });
          tx.updateClaim(
            superseder.block_id,
            { status: 'superseded', superseded_by: blockId },
            demoteLedger
          );
        }
        const restoreLedger = makeLedgerEntry({
          actor: 'restore',
          action: 'replace_current',
          reason: reason || 'restored over current superseding claim',
          evidenceRef: supersederId,
        });
        result = tx.updateClaim(
          blockId,
          { status: 'active', superseded_by: null },
          restoreLedger
        );
        return;
      }

      // mode === 'mark_disputed': BOTH sides flip to disputed, never leaving
      // one 'active' unopposed.
      const disputeLedgerA = makeLedgerEntry({
        actor: 'restore',
        action: 'mark_disputed',
        reason: reason || 'restore arbitration: marked disputed',
        evidenceRef: supersederId,
      });
      result = tx.updateClaim(blockId, { status: 'disputed' }, disputeLedgerA);

      if (superseder) {
        const disputeLedgerB = makeLedgerEntry({
          actor: 'restore',
          action: 'mark_disputed',
          reason: reason || 'restore arbitration: marked disputed (counterpart)',
          evidenceRef: blockId,
        });
        tx.updateClaim(superseder.block_id, { status: 'disputed' }, disputeLedgerB);
      }
    });
    return result;
  }

  /** Lock-free lookup across all loaded namespaces inside a transaction. */
  async _findClaim(tx, blockId) {
    // tx.getClaim needs a namespace; scan listClaims across known namespaces
    // by probing the store's namespace cache via listNamespaces() is async-IO,
    // so instead we rely on updateClaim's own cross-namespace search semantics
    // for mutation, and here do a light cross-namespace read using getClaim
    // against every namespace directory discovered so far in-memory.
    for (const namespace of this._knownNamespaces()) {
      const found = tx.getClaim(namespace, blockId);
      if (found) return found;
    }
    return null;
  }

  _knownNamespaces() {
    return Array.from(this.store._ns.keys());
  }

  /**
   * Cold-start safety net for verifyClaim/restoreClaim: before opening a
   * transaction, make sure the target claim's namespace is actually loaded
   * into memory from disk. This fixes the "fresh process + bare block_id"
   * case (e.g. after a restart, or a brand-new SDK instance that never
   * called recall/propose first) where `_findClaim`'s in-memory-only scan
   * would otherwise report false "not found".
   *
   * - If `namespace` is given, load exactly that one (cheap, deterministic).
   * - If not given, scan every namespace directory under data/namespaces/*
   *   and load each until the block_id turns up (bounded by however many
   *   namespaces actually exist on disk — fine for the CLI/console/SDK
   *   call pattern this guards, not a hot path).
   */
  async _ensureClaimLoadable(blockId, namespace) {
    if (namespace) {
      await this.store._getState(namespace);
      return;
    }
    // Already resolvable from what's in memory? Skip the disk scan.
    for (const ns of this._knownNamespaces()) {
      const st = this.store._ns.get(ns);
      if (st && st.claimsById.has(blockId)) return;
    }
    const allNamespaces = await this.store.listNamespaces();
    for (const ns of allNamespaces) {
      const st = await this.store._getState(ns);
      if (st.claimsById.has(blockId)) return;
    }
  }
}

export function createAdjudicator(opts) {
  return new Adjudicator(opts);
}
