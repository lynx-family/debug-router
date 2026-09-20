// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { randomInt } from "crypto";

const MIN_REQUEST_ID = 1;
const MAX_REQUEST_ID = 0x7fffffff;
const OUTER_ID_REQUEST_RESPONSE_TYPES = new Map([
  ["ListSession", "SessionList"],
]);
const OUTER_ID_RESPONSE_TYPES = new Set(
  OUTER_ID_REQUEST_RESPONSE_TYPES.values(),
);
const INNER_MESSAGE_ID_TYPES = new Set(["CDP", "App"]);

function isCustomizedMessage(message: any): boolean {
  return message?.event === "Customized";
}

function isValidRequestId(id: unknown): id is number {
  return (
    typeof id === "number" &&
    Number.isInteger(id) &&
    id >= 0 &&
    id <= MAX_REQUEST_ID
  );
}

function parseInnerMessage(message: any): any {
  const innerMessage = message?.data?.data?.message;
  if (typeof innerMessage !== "string") {
    return innerMessage;
  }

  try {
    return JSON.parse(innerMessage);
  } catch (_) {
    return undefined;
  }
}

/**
 * Correlates request/response messages sent through one transport connection.
 *
 * ListSession uses Customized.data.id. CDP and App keep using the id in their
 * inner message payload, matching their existing protocol format.
 */
export class CustomizedMessageCorrelation {
  private readonly pendingRequestIds = new Map<string, Set<number>>();

  prepareRequest<T>(message: T): T {
    if (!isCustomizedMessage(message)) {
      return message;
    }

    const type = (message as any).data.type;
    const responseType = OUTER_ID_REQUEST_RESPONSE_TYPES.get(type);
    if (responseType) {
      return this.prepareOuterIdRequest(message, responseType);
    }

    if (INNER_MESSAGE_ID_TYPES.has(type)) {
      const innerMessage = parseInnerMessage(message);
      if (
        typeof innerMessage?.method === "string" &&
        isValidRequestId(innerMessage.id)
      ) {
        this.addPendingRequest(type, innerMessage.id);
      }
    }

    return message;
  }

  shouldAcceptResponse(message: any): boolean {
    if (!isCustomizedMessage(message)) {
      return true;
    }

    const type = message.data.type;
    if (OUTER_ID_RESPONSE_TYPES.has(type)) {
      return this.shouldAcceptOuterIdResponse(message, type);
    }

    if (INNER_MESSAGE_ID_TYPES.has(type)) {
      const responseId = parseInnerMessage(message)?.id;
      // CDP/App messages without id are events rather than correlated
      // responses, so preserve their existing delivery behavior.
      if (responseId === undefined) {
        return true;
      }
      return (
        isValidRequestId(responseId) &&
        this.consumePendingRequest(type, responseId)
      );
    }

    return true;
  }

  private prepareOuterIdRequest<T>(message: T, responseType: string): T {
    const currentId = (message as any).data.id;
    const id = isValidRequestId(currentId)
      ? currentId
      : this.createRequestId(responseType);
    this.addPendingRequest(responseType, id);

    if (id === currentId) {
      return message;
    }

    return {
      ...(message as any),
      data: {
        ...(message as any).data,
        id,
      },
    } as T;
  }

  private shouldAcceptOuterIdResponse(
    message: any,
    responseType: string,
  ): boolean {
    const responseId = message.data.id;
    if (responseId === undefined) {
      // An old SDK cannot echo the id. Always preserve that compatibility,
      // including the existing unsolicited SessionList event behavior.
      this.consumeOldestPendingRequest(responseType);
      return true;
    }

    return (
      isValidRequestId(responseId) &&
      this.consumePendingRequest(responseType, responseId)
    );
  }

  private addPendingRequest(type: string, id: number): void {
    let ids = this.pendingRequestIds.get(type);
    if (!ids) {
      ids = new Set<number>();
      this.pendingRequestIds.set(type, ids);
    }
    ids.add(id);
  }

  private consumePendingRequest(type: string, id: number): boolean {
    const ids = this.pendingRequestIds.get(type);
    if (!ids?.delete(id)) {
      return false;
    }
    if (ids.size === 0) {
      this.pendingRequestIds.delete(type);
    }
    return true;
  }

  private consumeOldestPendingRequest(type: string): void {
    const ids = this.pendingRequestIds.get(type);
    const firstPendingId = ids?.values().next().value;
    if (firstPendingId !== undefined) {
      this.consumePendingRequest(type, firstPendingId);
    }
  }

  private createRequestId(responseType: string): number {
    const pendingIds = this.pendingRequestIds.get(responseType);
    let id: number;
    do {
      id = randomInt(MIN_REQUEST_ID, MAX_REQUEST_ID + 1);
    } while (pendingIds?.has(id));
    return id;
  }
}
