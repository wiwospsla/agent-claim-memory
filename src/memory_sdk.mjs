// src/memory_sdk.mjs
// Public facade for embedding this claim-memory layer into DSH or any other
// coding-agent host. One createClaimMemory() call per (dataDir, namespace)
// combination you want convenient defaults for; namespace can still be
// overridden per-call for cross-namespace operations.

import path from 'node:path';
import { createStore } from './store.mjs';
import { createAdjudicator } from './adjudicator.mjs';
import { recallClaims as recallClaimsImpl } from './recall.mjs';
import { compilePromptInjection as compileInjectionImpl } from './injector.mjs';
import { auditCompaction as auditCompactionImpl, evaluateCompactionFlow as evaluateFlowImpl } from './compaction_flow.mjs';
import { getVerdict as getVerdictImpl } from './stream_verdict.mjs';

export function createClaimMemory({ dataDir, namespace = 'default' } = {}) {
  if (!dataDir) throw new Error('createClaimMemory requires dataDir');
  const store = createStore({ dataDir: path.resolve(dataDir) });
  const adjudicator = createAdjudicator({ store });

  return {
    store,
    adjudicator,
    namespace,

    async propose(input) {
      return adjudicator.proposeClaim({ namespace, ...input });
    },

    async recall(ctx, opts = {}) {
      return recallClaimsImpl(ctx, { store, namespace, ...opts });
    },

    async compileInjection(ctx, opts = {}) {
      return compileInjectionImpl(ctx, { store, namespace, ...opts });
    },

    async verify(blockId, result) {
      return adjudicator.verifyClaim(blockId, { namespace, ...result });
    },

    async restore(blockId, opts) {
      return adjudicator.restoreClaim(blockId, { namespace, ...opts });
    },

    async auditCompaction(summaryText, meta) {
      return auditCompactionImpl(summaryText, meta, { store, namespace });
    },

    async evaluateCompactionFlow(opts = {}) {
      return evaluateFlowImpl({ store, namespace, ...opts });
    },

    async getVerdict(opts = {}) {
      return getVerdictImpl({ store, namespace, ...opts });
    },

    async getLedger(blockId) {
      const claim = await store.getClaim(namespace, blockId);
      if (!claim) return null;
      return { block_id: blockId, weight_ledger: claim.weight_ledger, status: claim.status };
    },

    async inspect(opts = {}) {
      const ns = opts.namespace || namespace;
      const claims = await store.listClaims(ns, () => true);
      const compactions = await store.listCompactions(ns);
      const grouped = { active: [], disputed: [], superseded: [], unverified: [], archived: [] };
      for (const c of claims) {
        (grouped[c.status] || (grouped[c.status] = [])).push(c);
      }
      return { namespace: ns, claims, grouped, compactions };
    },

    async verifyIndexConsistency(opts = {}) {
      return store.verifyIndexConsistency(opts.namespace || namespace);
    },

    getLoadDiagnostics(opts = {}) {
      return store.getLoadDiagnostics(opts.namespace || namespace);
    },
  };
}
