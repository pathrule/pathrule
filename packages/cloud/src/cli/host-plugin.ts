// SPDX-License-Identifier: Apache-2.0
/**
 * Pathrule Cloud in the host the CLI runs (`pathrule host run`): the account edition, binding the
 * person of each attached folder (../native/runtime.ts). Pathrule Cloud runs no daemon on this
 * machine and keeps no write queue: its writes go to the server directly.
 */
import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import type { HostPlugin } from "@pathrule/host/plugin.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import type { NativeAccount } from "../native/account.js";
import { nativeCloudRuntime } from "../native/runtime.js";

export interface CloudCliHostPluginOptions {
  /**
   * A native account the composition opted into (../native/account.ts): the host's account edition,
   * binding the person of each mapped local workspace. Absent, the account is Pathrule Cloud's own
   * session on this machine; a build that names no Pathrule Cloud has no account edition.
   */
  native?: NativeAccount;
}

export function cloudCliHostPlugin(options: CloudCliHostPluginOptions = {}): HostPlugin {
  return {
    name: "cloud",
    contract: HOST_PLUGIN_CONTRACT,
    sharedPackages: [CORE_PACKAGE, INTEGRATIONS_PACKAGE],
    async activate(ctx) {
      if (options.native) {
        ctx.provideAccount(options.native.edition());
        return;
      }
      const native = nativeCloudRuntime({ env: ctx.env });
      if (native) ctx.provideAccount(native.edition);
    },
    async deactivate() {},
  };
}
