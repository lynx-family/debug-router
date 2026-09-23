// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export const DEFAULT_PENDING_ROUTE_TIMEOUT_MS = 5000;

export type PendingRoute = {
  kind: "control" | "websocket";
  globalMessageId: number;
  requesterId: number;
  originalId: number;
  clientId: number;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
};

export type PendingRouteTableOption = {
  timeoutMs?: number;
  now?: () => number;
  onTimeout?: (route: PendingRoute) => void;
  setTimeout?: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

export class PendingRouteTable {
  private readonly routes = new Map<number, PendingRoute>();
  private nextGlobalMessageId = 1;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onTimeout?: (route: PendingRoute) => void;
  private readonly setTimeoutFn: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (
    timer: ReturnType<typeof setTimeout>,
  ) => void;

  constructor(option: PendingRouteTableOption = {}) {
    this.timeoutMs = option.timeoutMs ?? DEFAULT_PENDING_ROUTE_TIMEOUT_MS;
    this.now = option.now ?? Date.now;
    this.onTimeout = option.onTimeout;
    this.setTimeoutFn = option.setTimeout ?? setTimeout;
    this.clearTimeoutFn = option.clearTimeout ?? clearTimeout;
  }

  add(
    input: Omit<PendingRoute, "globalMessageId" | "createdAt" | "timer">,
  ): PendingRoute {
    const globalMessageId = this.createGlobalMessageId();
    const route: PendingRoute = {
      ...input,
      globalMessageId,
      createdAt: this.now(),
      timer: this.createTimer(globalMessageId),
    };

    this.routes.set(globalMessageId, route);
    return route;
  }

  get(globalMessageId: number): PendingRoute | null {
    return this.routes.get(globalMessageId) ?? null;
  }

  take(globalMessageId: number): PendingRoute | null {
    return this.remove(globalMessageId, true);
  }

  clearByControlId(controlId: number): PendingRoute[] {
    return this.clearMatching((route) => {
      return route.kind === "control" && route.requesterId === controlId;
    });
  }

  clearByWebClientId(webClientId: number): PendingRoute[] {
    return this.clearMatching((route) => {
      return route.kind === "websocket" && route.requesterId === webClientId;
    });
  }

  clearByClientId(clientId: number): PendingRoute[] {
    return this.clearMatching((route) => route.clientId === clientId);
  }

  clear(): PendingRoute[] {
    return this.clearMatching(() => true);
  }

  private createGlobalMessageId(): number {
    return this.nextGlobalMessageId++;
  }

  private createTimer(globalMessageId: number): ReturnType<typeof setTimeout> {
    return this.setTimeoutFn(() => {
      const route = this.remove(globalMessageId, false);
      if (!route) {
        return;
      }

      if (route.kind === "control") {
        route.reject?.(
          new Error(
            `Timed out waiting for response to global message id ${globalMessageId}`,
          ),
        );
      }
      this.onTimeout?.(route);
    }, this.timeoutMs);
  }

  private remove(
    globalMessageId: number,
    shouldClearTimer: boolean,
  ): PendingRoute | null {
    const route = this.routes.get(globalMessageId);
    if (!route) {
      return null;
    }

    this.routes.delete(globalMessageId);
    if (shouldClearTimer) {
      this.clearTimeoutFn(route.timer);
    }
    return route;
  }

  private clearMatching(
    matches: (route: PendingRoute) => boolean,
  ): PendingRoute[] {
    const removed: PendingRoute[] = [];
    for (const pendingRoute of Array.from(this.routes.values())) {
      if (!matches(pendingRoute)) {
        continue;
      }

      const route = this.remove(pendingRoute.globalMessageId, true);
      if (route) {
        removed.push(route);
      }
    }

    return removed;
  }
}
