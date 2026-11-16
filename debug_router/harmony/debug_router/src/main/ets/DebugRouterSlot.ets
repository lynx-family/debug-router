// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { DebugRouterSlotDelegate } from './DebugRouterSlotDelegate';
import { DebugRouter } from './DebugRouter';

// Obsoleted legacy protocol: public Target type name.
export class DebugRouterSlot {
  private plugged: boolean;
  private targetId: number;
  private delegate: DebugRouterSlotDelegate | null;
  private type: string;

  constructor() {
    this.plugged = false;
    this.targetId = 0;
    this.type = '';
    this.delegate = null;
  }

  public plug(): number {
    this.pull();
    this.targetId = DebugRouter.plug(this);
    this.plugged = true;
    return this.targetId;
  }

  public pull(): void {
    if (this.plugged) {
      DebugRouter.pull(this.targetId);
      this.plugged = false;
    }
  }

  public sendAsync(message: string): void {
    DebugRouter.sendAsync(message);
  }

  public sendDataAsync(data: string, type: string): void {
    DebugRouter.sendDataAsync(type, this.targetId, data);
  }

  // delegate methods
  public getTemplateUrl(): string {
    if (this.delegate) {
      return this.delegate.getTemplateUrl();
    }
    return '';
  }

  public onMessage(message: string, type: string): void {
    if (this.delegate) {
      this.delegate.onMessage(message, type);
    }
  }

  public setDelegate(delegate: DebugRouterSlotDelegate): void {
    this.delegate = delegate;
  }

  public setType(type: string): void {
    this.type = type;
  }

  public getType(): string {
    return this.type;
  }
}
