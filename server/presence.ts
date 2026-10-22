// Which paired devices have the app open and visible right now, so the server can skip their push
// instead of the service worker dropping it. iOS treats a push that shows no notification as a
// silent push and revokes the subscription after a few, so the drop has to happen before sending.
//
// Each open window (a "client", random per page load) reports visible/hidden and beats while
// visible. A client counts as visible only until its lease runs out: when iOS freezes the page the
// "hidden" report can be lost, and then pushes resume once the lease expires.

export const PRESENCE_LEASE_MS = 40_000;

export class Presence {
  /** `${device}\n${client}` → lease expiry (ms). */
  private leases = new Map<string, number>();

  report(device: string, client: string, visible: boolean, now = Date.now()) {
    const key = `${device}\n${client}`;
    if (visible) this.leases.set(key, now + PRESENCE_LEASE_MS);
    else this.leases.delete(key);
    this.prune(now);
  }

  /** True while any window of this device is visible with a live lease. */
  visible(device: string, now = Date.now()): boolean {
    const prefix = `${device}\n`;
    for (const [key, until] of this.leases) if (until > now && key.startsWith(prefix)) return true;
    return false;
  }

  private prune(now: number) {
    for (const [key, until] of this.leases) if (until <= now) this.leases.delete(key);
  }
}

export const presence = new Presence();
