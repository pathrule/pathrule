// SPDX-License-Identifier: Apache-2.0
// This copy of @pathrule/integrations. Its module state (the per-process memos of the renderers and
// the hook-index writer) must be the process's only copy, so the plugin seams compare this token
// with the one a plugin resolved (`@pathrule/protocol/package-instance.js`).
import { packageInstance } from "@pathrule/protocol/package-instance.js";

export const INTEGRATIONS_PACKAGE = packageInstance("@pathrule/integrations", import.meta.url);
