// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { SocketEvent } from "../../utils/type";

export const DEFAULT_MEMOIZED_QUERY_TTL_MS = 1000;

export type MemoizedQueryDefinition = {
  requestType: string;
  notificationType: string;
};

export type MemoizedQueryDecision =
  | {
      action: "not-memoized";
    }
  | {
      action: "forward";
      requestType: string;
    }
  | {
      action: "pending";
    }
  | {
      action: "cached";
      message: string;
      parsedValue: unknown;
    };

export type MemoizedQueryTableOption = {
  definitions?: readonly MemoizedQueryDefinition[];
  validityPeriodMs?: number;
  now?: () => number;
};

type MemoizedNotification = {
  message: string;
  parsedValue: unknown;
  receivedAt: number;
};

type PendingQuery = {
  sentAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_QUERY_DEFINITIONS: readonly MemoizedQueryDefinition[] = [
  {
    requestType: "ListSession",
    notificationType: "SessionList",
  },
];

export class MemoizedQueryTable {
  private readonly definitions: readonly MemoizedQueryDefinition[];
  private readonly notifications = new Map<
    number,
    Map<string, MemoizedNotification>
  >();
  private readonly pendingQueries = new Map<
    number,
    Map<string, PendingQuery>
  >();
  private readonly validityPeriodMs: number;
  private readonly now: () => number;

  constructor(option: MemoizedQueryTableOption = {}) {
    this.validityPeriodMs =
      option.validityPeriodMs ?? DEFAULT_MEMOIZED_QUERY_TTL_MS;
    this.now = option.now ?? Date.now;
    this.definitions = option.definitions ?? DEFAULT_QUERY_DEFINITIONS;
  }

  query(clientId: number, message: unknown): MemoizedQueryDecision {
    const requestType = getCustomizedType(message);
    const notificationType = this.definitions.find(
      (definition) => definition.requestType === requestType,
    )?.notificationType;
    if (!requestType || !notificationType) {
      return {
        action: "not-memoized",
      };
    }

    const cached = this.getFreshNotification(clientId, notificationType);
    if (cached) {
      return {
        action: "cached",
        message: cached.message,
        parsedValue: cached.parsedValue,
      };
    }

    if (this.isPending(clientId, requestType)) {
      return {
        action: "pending",
      };
    }

    this.markPending(clientId, requestType);
    return {
      action: "forward",
      requestType,
    };
  }

  recordNotification(
    clientId: number,
    message: string,
    parsedValue: unknown,
  ): void {
    const notificationType = getCustomizedType(parsedValue);
    const requestType = this.definitions.find(
      (definition) => definition.notificationType === notificationType,
    )?.requestType;
    if (!notificationType || !requestType) {
      return;
    }

    let clientNotifications = this.notifications.get(clientId);
    if (!clientNotifications) {
      clientNotifications = new Map<string, MemoizedNotification>();
      this.notifications.set(clientId, clientNotifications);
    }
    clientNotifications.set(notificationType, {
      message,
      parsedValue,
      receivedAt: this.now(),
    });
    this.clearPending(clientId, requestType);
  }

  handleSendFailure(clientId: number, requestType: string): void {
    this.clearPending(clientId, requestType);
  }

  setRetryTimer(
    clientId: number,
    requestType: string,
    retry: () => boolean,
  ): void {
    const pendingQuery = this.pendingQueries.get(clientId)!.get(requestType)!;
    pendingQuery.timer = this.createRetryTimer(
      clientId,
      requestType,
      pendingQuery,
      retry,
    );
  }

  clearClient(clientId: number): void {
    this.notifications.delete(clientId);
    const clientPendingQueries = this.pendingQueries.get(clientId);
    clientPendingQueries?.forEach((_pendingQuery, requestType) => {
      this.clearPending(clientId, requestType);
    });
  }

  clear(): void {
    this.notifications.clear();
    this.pendingQueries.forEach((clientPendingQueries, clientId) => {
      clientPendingQueries.forEach((_pendingQuery, requestType) => {
        this.clearPending(clientId, requestType);
      });
    });
  }

  private getFreshNotification(
    clientId: number,
    notificationType: string,
  ): MemoizedNotification | null {
    const notification =
      this.notifications.get(clientId)?.get(notificationType) ?? null;
    if (!notification) {
      return null;
    }
    if (this.now() - notification.receivedAt > this.validityPeriodMs) {
      return null;
    }
    return notification;
  }

  private isPending(clientId: number, requestType: string): boolean {
    const pendingQuery = this.pendingQueries.get(clientId)?.get(requestType);
    if (!pendingQuery) {
      return false;
    }
    if (this.now() - pendingQuery.sentAt > this.validityPeriodMs) {
      // The pending query has expired and can no longer be reused.
      this.clearPending(clientId, requestType);
      return false;
    }

    return true;
  }

  private markPending(clientId: number, requestType: string): void {
    let clientPendingQueries = this.pendingQueries.get(clientId);
    if (!clientPendingQueries) {
      clientPendingQueries = new Map<string, PendingQuery>();
      this.pendingQueries.set(clientId, clientPendingQueries);
    }
    clientPendingQueries.set(requestType, {
      sentAt: this.now(),
    });
  }

  private clearPending(clientId: number, requestType: string): void {
    const clientPendingQueries = this.pendingQueries.get(clientId);
    if (!clientPendingQueries) {
      return;
    }
    const pendingQuery = clientPendingQueries.get(requestType);
    if (!pendingQuery) {
      return;
    }
    this.clearRetryTimer(pendingQuery);
    clientPendingQueries.delete(requestType);
    if (clientPendingQueries.size === 0) {
      this.pendingQueries.delete(clientId);
    }
  }

  private createRetryTimer(
    clientId: number,
    requestType: string,
    pendingQuery: PendingQuery,
    retry: () => boolean,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      pendingQuery.sentAt = this.now();
      if (!retry()) {
        this.clearPending(clientId, requestType);
        return;
      }

      pendingQuery.timer = this.createRetryTimer(
        clientId,
        requestType,
        pendingQuery,
        retry,
      );
    }, this.validityPeriodMs);
    timer.unref?.();
    return timer;
  }

  private clearRetryTimer(pendingQuery: PendingQuery): void {
    if (pendingQuery.timer === undefined) {
      return;
    }
    clearTimeout(pendingQuery.timer);
    pendingQuery.timer = undefined;
  }
}

function getCustomizedType(message: unknown): string | null {
  const data = message as any;
  if (data?.event !== SocketEvent.Customized) {
    return null;
  }
  return typeof data?.data?.type === "string" ? data.data.type : null;
}
