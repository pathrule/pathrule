// SPDX-License-Identifier: Apache-2.0
/**
 * The attribution authority that observes a delivered atom's outcome: the open, deterministic and
 * model-free decisions in `@pathrule/agent-ir`.
 */
import {
  attributeUsage,
  classifyCheckOutcome,
  classifyCommandOutcome,
  classifyErrorPersistenceOutcome,
  observeCondition,
} from "@pathrule/agent-ir/verification/outcome.js";

export interface OutcomeObserver {
  attributeUsage: typeof attributeUsage;
  observeCondition: typeof observeCondition;
  classifyCommandOutcome: typeof classifyCommandOutcome;
  classifyCheckOutcome: typeof classifyCheckOutcome;
  classifyErrorPersistenceOutcome: typeof classifyErrorPersistenceOutcome;
}

const OPEN_OUTCOME_OBSERVER: OutcomeObserver = {
  attributeUsage,
  observeCondition,
  classifyCommandOutcome,
  classifyCheckOutcome,
  classifyErrorPersistenceOutcome,
};

export function outcomeObserver(): OutcomeObserver {
  return OPEN_OUTCOME_OBSERVER;
}
