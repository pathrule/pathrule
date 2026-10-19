// SPDX-License-Identifier: Apache-2.0
/**
 * Which copy of a shared package a module resolved. Some open packages hold state that the whole
 * process must share:
 * - core holds the engine slot, the file write queues and the store caches;
 * - integrations holds its per-process memos;
 * - mcp holds its cache, the client identity and its plugin registry;
 * - cli holds its plugin registry.
 *
 * Each of these packages exports one token, created once per copy of the package. A seam compares the
 * tokens a plugin resolved with its own.
 * - The same token means the same copy.
 * - A different token means a second copy. Its state is invisible to the host: an engine installed
 *   there, for example, is an engine the host never sees. The seam refuses that plugin loudly, so
 *   the second copy is never used silently.
 *
 * npm keeps one copy when the packages are peers of each other and come from one release. This check
 * catches an install that was forced past that.
 */

export interface PackageInstance {
  /** The npm name of the package. */
  readonly name: string;
  /** Where this copy was loaded from: the URL of its token module. */
  readonly location: string;
}

/** The token of one copy of a package. Each shared package creates its own once, in one module. */
export function packageInstance(name: string, location: string): PackageInstance {
  return Object.freeze({ name, location });
}

/** A plugin resolved a shared package to another copy than the one the host uses. */
export class DuplicatePackageError extends Error {
  readonly packageName: string;
  readonly hostLocation: string;
  readonly pluginLocation: string;

  constructor(input: {
    seam: string;
    plugin: string;
    host: PackageInstance;
    resolved: PackageInstance;
  }) {
    super(
      `The ${input.seam} plugin "${input.plugin}" loaded a second copy of ${input.host.name}.\n` +
        `  this process uses: ${input.host.location}\n` +
        `  the plugin loaded:  ${input.resolved.location}\n` +
        `State in one copy is invisible to the other, so the plugin was not installed. The plugin ` +
        `must resolve the copy this process uses: install it from the same release, sharing this ` +
        `install's ${input.host.name} (the Pathrule CLI links the capabilities it installs to its ` +
        `own packages; \`pathrule setup\` reinstalls them).`,
    );
    this.name = "DuplicatePackageError";
    this.packageName = input.host.name;
    this.hostLocation = input.host.location;
    this.pluginLocation = input.resolved.location;
  }
}

/**
 * Throws a `DuplicatePackageError` when a plugin resolved a package the host shares to another copy.
 * Ignores a package that the plugin lists and the host does not share.
 */
export function assertSharedPackages(input: {
  seam: string;
  plugin: string;
  host: readonly PackageInstance[];
  resolved: readonly PackageInstance[];
}): void {
  for (const resolved of input.resolved) {
    const host = input.host.find((own) => own.name === resolved.name);
    if (host && host !== resolved) {
      throw new DuplicatePackageError({ seam: input.seam, plugin: input.plugin, host, resolved });
    }
  }
}
