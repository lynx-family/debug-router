// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { SocketEvent } from "../../utils/type";

export const DEFAULT_MEMOIZED_NOTIFICATION_TTL_MS = 1000;

export type MemoizedNotificationQueryDefinition = {
  requestType: string;
  notificationType: string;
};

export type MemoizedNotificationQueryDecision =
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
    };

export type MemoizedNotificationQueryTableOption = {
  definitions?: readonly MemoizedNotificationQueryDefinition[];
  ttlMs?: number;
  now?: () => number;
};

type MemoizedNotification = {
  message: string;
  receivedAt: number;
};

const DEFAULT_QUERY_DEFINITIONS: readonly MemoizedNotificationQueryDefinition[] = [
  {
    requestType: "ListSession",
    notificationType: "SessionList",
  },
];

export class MemoizedNotificationQueryTable {
  private readonly notificationTypeByRequestType = new Map<string, string>();
  private readonly requestTypeByNotificationType = new Map<string, string>();
  private readonly notifications = new Map<
    number,
    Map<string, MemoizedNotification>
  >();
  private readonly pendingQueries = new Map<number, Map<string, number>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(option: MemoizedNotificationQueryTableOption = {}) {
    this.ttlMs = resolveTtlMs(option.ttlMs);
    this.now = option.now ?? Date.now;

    const definitions = option.definitions ?? DEFAULT_QUERY_DEFINITIONS;
    for (const definition of definitions) {
      this.notificationTypeByRequestType.set(
        definition.requestType,
        definition.notificationType,
      );
      this.requestTypeByNotificationType.set(
        definition.notificationType,
        definition.requestType,
      );
    }
  }

  query(clientId: number, message: unknown): MemoizedNotificationQueryDecision {
    const requestType = getCustomizedType(message);
    const notificationType = requestType
      ? this.notificationTypeByRequestType.get(requestType)
      : undefined;
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

  recordNotification(clientId: number, message: string): boolean {
    const notificationType = getCustomizedType(parseJsonOrNull(message));
    const requestType = notificationType
      ? this.requestTypeByNotificationType.get(notificationType)
      : undefined;
    if (!notificationType || !requestType) {
      return false;
    }

    let clientNotifications = this.notifications.get(clientId);
    if (!clientNotifications) {
      clientNotifications = new Map<string, MemoizedNotification>();
      this.notifications.set(clientId, clientNotifications);
    }
    clientNotifications.set(notificationType, {
      message,
      receivedAt: this.now(),
    });
    this.clearPending(clientId, requestType);
    return true;
  }

  handleSendFailure(clientId: number, requestType: string): void {
    this.clearPending(clientId, requestType);
  }

  clearClient(clientId: number): void {
    this.notifications.delete(clientId);
    this.pendingQueries.delete(clientId);
  }

  clear(): void {
    this.notifications.clear();
    this.pendingQueries.clear();
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
    if (this.now() - notification.receivedAt > this.ttlMs) {
      return null;
    }
    return notification;
  }

  private isPending(clientId: number, requestType: string): boolean {
    const sentAt = this.pendingQueries.get(clientId)?.get(requestType);
    if (sentAt === undefined) {
      return false;
    }
    if (this.now() - sentAt <= this.ttlMs) {
      return true;
    }

    this.clearPending(clientId, requestType);
    return false;
  }

  private markPending(clientId: number, requestType: string): void {
    let clientPendingQueries = this.pendingQueries.get(clientId);
    if (!clientPendingQueries) {
      clientPendingQueries = new Map<string, number>();
      this.pendingQueries.set(clientId, clientPendingQueries);
    }
    clientPendingQueries.set(requestType, this.now());
  }

  private clearPending(clientId: number, requestType: string): void {
    const clientPendingQueries = this.pendingQueries.get(clientId);
    if (!clientPendingQueries) {
      return;
    }
    clientPendingQueries.delete(requestType);
    if (clientPendingQueries.size === 0) {
      this.pendingQueries.delete(clientId);
    }
  }
}

function resolveTtlMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MEMOIZED_NOTIFICATION_TTL_MS;
  }
  return value;
}

function getCustomizedType(message: unknown): string | null {
  const data = message as any;
  if (data?.event !== SocketEvent.Customized) {
    return null;
  }
  return typeof data?.data?.type === "string" ? data.data.type : null;
}

function parseJsonOrNull(message: string): unknown | null {
  try {
    return JSON.parse(message);
  } catch (_error) {
    return null;
  }
}
