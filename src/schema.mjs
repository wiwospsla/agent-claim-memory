// src/schema.mjs
// Frozen Claim schema (schema_version 1) and shared constants.
// Pure data + validation module — no I/O, no locking, no time-decay logic.

export const SCHEMA_VERSION = 1;

export const KINDS = Object.freeze([
  'decision',
  'constraint',
  'pitfall',
  'api_shape',
  'todo',
  'hypothesis',
]);

export const STATUSES = Object.freeze([
  'active',
  'superseded',
  'disputed',
  'unverified',
  'archived',
]);

export const AUTHORITIES = Object.freeze([
  'user_explicit',
  'tool_verified',
  'agent_inferred',
]);

export const SOURCE_KINDS = Object.freeze(['user', 'tool', 'infer']);

export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 1;
export const UTILITY_MIN = 0.2;
export const UTILITY_MAX = 1.5;

export class ClaimValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ClaimValidationError';
    this.field = field;
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function clampConfidence(n) {
  return clamp(n, CONFIDENCE_MIN, CONFIDENCE_MAX);
}

export function clampUtility(n) {
  return clamp(n, UTILITY_MIN, UTILITY_MAX);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Normalize/validate a scope object. Missing arrays default to [].
 */
export function normalizeScope(scope) {
  const s = scope || {};
  const files = isStringArray(s.files) ? s.files.slice() : [];
  const modules = isStringArray(s.modules) ? s.modules.slice() : [];
  const tags = isStringArray(s.tags) ? s.tags.slice() : [];
  return { files, modules, tags };
}

/**
 * Validate a source descriptor. Source is mandatory provenance.
 */
export function validateSource(source) {
  if (!source || typeof source !== 'object') {
    throw new ClaimValidationError('source is required', 'source');
  }
  if (!SOURCE_KINDS.includes(source.kind)) {
    throw new ClaimValidationError(
      `source.kind must be one of ${SOURCE_KINDS.join(',')}`,
      'source.kind'
    );
  }
  if (!isNonEmptyString(source.ref)) {
    throw new ClaimValidationError('source.ref is required (provenance ref)', 'source.ref');
  }
  const timestamp = isNonEmptyString(source.timestamp)
    ? source.timestamp
    : new Date().toISOString();
  return { kind: source.kind, ref: source.ref, timestamp };
}

/**
 * Build a weight ledger entry. Ledger entries are append-only, never mutated.
 */
export function makeLedgerEntry({ actor, action, delta = 0, reason = '', evidenceRef = null }) {
  return {
    at: new Date().toISOString(),
    actor: actor || 'system',
    action,
    delta,
    reason,
    evidence_ref: evidenceRef,
  };
}

/**
 * Validate and normalize a full claim record. Throws ClaimValidationError on
 * structural problems. Does not touch storage.
 */
export function buildClaim(input) {
  if (!input || typeof input !== 'object') {
    throw new ClaimValidationError('claim input must be an object', 'root');
  }
  if (!isNonEmptyString(input.block_id)) {
    throw new ClaimValidationError('block_id is required', 'block_id');
  }
  if (!KINDS.includes(input.kind)) {
    throw new ClaimValidationError(`kind must be one of ${KINDS.join(',')}`, 'kind');
  }
  if (!isNonEmptyString(input.claim)) {
    throw new ClaimValidationError('claim text is required', 'claim');
  }
  const status = STATUSES.includes(input.status) ? input.status : 'unverified';
  const authority = AUTHORITIES.includes(input.authority) ? input.authority : 'agent_inferred';
  const confidence = clampConfidence(
    typeof input.confidence === 'number' ? input.confidence : 0.5
  );
  const utility = clampUtility(typeof input.utility === 'number' ? input.utility : 0.6);
  const source = validateSource(input.source);
  const scope = normalizeScope(input.scope);

  return {
    schema_version: SCHEMA_VERSION,
    block_id: input.block_id,
    namespace: isNonEmptyString(input.namespace) ? input.namespace : 'default',
    kind: input.kind,
    scope,
    claim: input.claim.trim(),
    status,
    authority,
    confidence,
    utility,
    source,
    superseded_by: input.superseded_by ?? null,
    evidence: isNonEmptyString(input.evidence) ? input.evidence : (input.evidence ?? null),
    weight_ledger: Array.isArray(input.weight_ledger) ? input.weight_ledger.slice() : [],
    created_at: isNonEmptyString(input.created_at) ? input.created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
