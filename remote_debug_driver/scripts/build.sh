#!/bin/bash

# Copyright 2025 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

set -e
rm -rf ./dist
tsc --project tsconfig.json --module CommonJS --outDir ./dist/cjs
tsc --project tsconfig.json --module ES2015 --outDir ./dist/esm
