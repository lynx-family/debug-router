// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export const DEFAULT_PENDING_ROUTE_TIMEOUT_MS = 10000;

export type PendingRoute = PendingControlRoute | PendingWebSocketRoute;

export type PendingControlRoute = {
  kind: "control";
  globalMessageId: number;
  controlId: number;
  originalId: number;
  clientId: number;
  createdAt: number;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
};

export type PendingWebSocketRoute = {
  kind: "websocket";
  globalMessageId: number;
  webClientId: number;
  originalId: number;
  clientId: number;
  createdAt: number;
};

export type PendingRouteSeed =
  | Omit<PendingControlRoute, "globalMessageId" | "createdAt">
  | Omit<PendingWebSocketRoute, "globalMessageId" | "createdAt">;

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

type PendingRouteEntry = {
  route: PendingRoute;
  timer: ReturnType<typeof setTimeout> | null;
};

export class PendingRouteTable {
  private readonly routes = new Map<number, PendingRouteEntry>();
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

  get size(): number {
    return this.routes.size;
  }

  add(globalMessageId: number, seed: PendingRouteSeed): PendingRoute {
    assertMessageId(globalMessageId, "globalMessageId");
    assertMessageId(seed.originalId, "originalId");
    assertClientId(seed.clientId, "clientId");
    if (seed.kind === "control") {
      assertClientId(seed.controlId, "controlId");
    } else {
      assertClientId(seed.webClientId, "webClientId");
    }
    if (this.routes.has(globalMessageId)) {
      throw new Error(
        `Pending route already exists for global message id ${globalMessageId}`,
      );
    }

    const route: PendingRoute = {
      ...seed,
      globalMessageId,
      createdAt: this.now(),
    };
    const entry: PendingRouteEntry = {
      route,
      timer: this.createTimer(globalMessageId),
    };

    this.routes.set(globalMessageId, entry);
    return route;
  }

  has(globalMessageId: number): boolean {
    return this.routes.has(globalMessageId);
  }

  get(globalMessageId: number): PendingRoute | null {
    return this.routes.get(globalMessageId)?.route ?? null;
  }

  take(globalMessageId: number): PendingRoute | null {
    return this.remove(globalMessageId, true);
  }

  delete(globalMessageId: number): PendingRoute | null {
    return this.remove(globalMessageId, true);
  }

  clearByControlId(controlId: number): PendingRoute[] {
    assertClientId(controlId, "controlId");
    return this.clearMatching((route) => {
      return route.kind === "control" && route.controlId === controlId;
    });
  }

  clearByWebClientId(webClientId: number): PendingRoute[] {
    assertClientId(webClientId, "webClientId");
    return this.clearMatching((route) => {
      return route.kind === "websocket" && route.webClientId === webClientId;
    });
  }

  clear(): PendingRoute[] {
    return this.clearMatching(() => true);
  }

  private createTimer(
    globalMessageId: number,
  ): ReturnType<typeof setTimeout> | null {
    if (this.timeoutMs <= 0) {
      return null;
    }

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
    const entry = this.routes.get(globalMessageId);
    if (!entry) {
      return null;
    }

    this.routes.delete(globalMessageId);
    if (shouldClearTimer && entry.timer) {
      this.clearTimeoutFn(entry.timer);
    }
    return entry.route;
  }

  private clearMatching(
    matches: (route: PendingRoute) => boolean,
  ): PendingRoute[] {
    const removed: PendingRoute[] = [];
    for (const entry of Array.from(this.routes.values())) {
      if (!matches(entry.route)) {
        continue;
      }

      const route = this.remove(entry.route.globalMessageId, true);
      if (route) {
        removed.push(route);
      }
    }

    return removed;
  }
}

function assertMessageId(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
}

function assertClientId(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
}
