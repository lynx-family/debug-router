// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

NS_ASSUME_NONNULL_BEGIN

@protocol DebugRouterGlobalHandler <NSObject>

@required
- (void)openCard:(NSString *)url;

- (void)onMessage:(NSString *)message withType:(NSString *)type;

@end

NS_ASSUME_NONNULL_END
