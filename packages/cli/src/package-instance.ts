// SPDX-License-Identifier: Apache-2.0
// This copy of @pathrule/cli. Its module state (the plugin registry) must be the process's only
// copy, so the plugin seams compare this token with the one a plugin resolved
// (`@pathrule/protocol/package-instance.js`).
import { packageInstance } from "@pathrule/protocol/package-instance.js";

export const CLI_PACKAGE = packageInstance("@pathrule/cli", import.meta.url);
