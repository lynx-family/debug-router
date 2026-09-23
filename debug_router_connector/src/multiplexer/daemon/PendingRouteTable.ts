// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export const DEFAULT_PENDING_ROUTE_TIMEOUT_MS = 5000;

export type PendingRouteInput = {
  kind: "control" | "websocket";
  requesterId: number;
  originalId: number;
  clientId: number;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
};

export type PendingRoute = PendingRouteInput & {
  globalMessageId: number;
  createdAt: number;
  timer: NodeJS.Timeout;
};

export type PendingRouteTableOption = {
  timeoutMs?: number;
};

export class PendingRouteTable {
  /**
   * Tracks pending requests with global message IDs, preserving the requester,
   * original message ID, and target client for response routing.
   * Supports timeout cleanup and bulk removal by requester or target client.
   */
  private readonly routes = new Map<number, PendingRoute>();
  private nextGlobalMessageId = 1;
  private readonly timeoutMs: number;

  constructor(option: PendingRouteTableOption = {}) {
    this.timeoutMs = option.timeoutMs ?? DEFAULT_PENDING_ROUTE_TIMEOUT_MS;
  }

  add(input: PendingRouteInput): PendingRoute {
    const globalMessageId = this.createGlobalMessageId();
    const route: PendingRoute = {
      ...input,
      globalMessageId,
      createdAt: Date.now(),
      timer: this.createTimer(globalMessageId),
    };

    this.routes.set(globalMessageId, route);
    return route;
  }

  private createTimer(globalMessageId: number): NodeJS.Timeout {
    // Creates a timer that removes the route on timeout and rejects control requests.
    return setTimeout(() => {
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
    }, this.timeoutMs);
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
      clearTimeout(route.timer);
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
