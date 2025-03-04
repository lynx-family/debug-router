// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

// @ts-ignore
import * as utf8 from "utf8";
// @ts-ignore
import * as bufferpack from "bufferpack";

export function packMessage(data: any): Buffer {
  const enc = utf8.encode(JSON.stringify(data));
  const packed_data = bufferpack.pack(`! I I I I I ${enc.length}s`, [
    1,
    101,
    0,
    enc.length + 4,
    enc.length,
    enc,
  ]);
  return packed_data;
}

export function buildClientId(clientInfo: {
  app: string;
  os: string;
  device: string;
  device_id: string;
  port: string;
}): string {
  const escapedName = escape(clientInfo.app);
  const result = `${escapedName}#${clientInfo.os}#${clientInfo.device}#${clientInfo.device_id}#${clientInfo.port}`;
  return result;
}
