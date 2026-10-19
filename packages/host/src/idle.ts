// SPDX-License-Identifier: Apache-2.0
/**
 * When a host stops by itself. A host launched for the surfaces that need it (the CLI, MCP, VS Code)
 * stops once it has been idle for a while: no request in flight, none arriving for `timeoutMs`, and
 * no plugin keeping it running. A plugin with work of its own (Cloud's daemon job while an account
 * is signed in) keeps it running until it lets go. A host with no timeout never stops by itself.
 */
export class IdleWatch {
  private inFlight = 0;
  private readonly holds = new Map<number, string>();
  private nextHold = 0;
  private timer: NodeJS.Timeout | null = null;
  private watching = false;
  private closed = false;

  constructor(
    private readonly timeoutMs: number | undefined,
    private readonly onIdle: () => void,
  ) {}

  /** Starts counting, once the host serves. */
  start(): void {
    this.watching = true;
    this.arm();
  }

  /** A request arrived. */
  begin(): void {
    this.inFlight += 1;
    this.disarm();
  }

  /** A request was answered. */
  end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.arm();
  }

  /** Keeps the host running until the returned function is called (once is enough). */
  hold(reason: string): () => void {
    if (this.closed) return () => {};
    const id = (this.nextHold += 1);
    this.holds.set(id, reason);
    this.disarm();
    return () => {
      if (this.holds.delete(id)) this.arm();
    };
  }

  /** Why the host is kept running, in the order the holds were taken. */
  heldBy(): string[] {
    return [...this.holds.values()];
  }

  close(): void {
    this.closed = true;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    if (this.closed || !this.watching || this.timeoutMs === undefined) return;
    if (this.inFlight > 0 || this.holds.size > 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed && this.inFlight === 0 && this.holds.size === 0) this.onIdle();
    }, this.timeoutMs);
    // The server keeps a serving process alive; this timer alone never should.
    this.timer.unref();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
