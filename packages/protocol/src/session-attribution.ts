// SPDX-License-Identifier: Apache-2.0
/**
 * What the hook delivered to one agent session, drained once at the session's activity boundary.
 * The hook writes it; whoever records the delivery reads it.
 */
export interface SessionAttribution {
  /** sha256 hex of the prompt this batch is attributed to. */
  intent_hash: string;
  /**
   * The prompt embedding the hook already computed for its own ranking, when this machine
   * has an embedding key. Null when it does not — `intent_text` carries the intent then.
   */
  vector: number[] | null;
  /** The prompt text, present only when `vector` is null. Never both. */
  intent_text: string | null;
  /** Every memory id delivered in the drained batch, deduped. */
  memory_ids: string[];
  /** Lines parsed, for logging/tests. */
  lines: number;
}
