// SPDX-License-Identifier: Apache-2.0
// This copy of @pathrule/core. Its module state (the engine slot, the file write queues and the
// store caches) must be the process's only copy, so the plugin seams compare this token with the
// one a plugin resolved (`@pathrule/protocol/package-instance.js`).
import { packageInstance } from "@pathrule/protocol/package-instance.js";

export const CORE_PACKAGE = packageInstance("@pathrule/core", import.meta.url);
