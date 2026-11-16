// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

NS_ASSUME_NONNULL_BEGIN

// Obsoleted legacy protocol: Session callbacks describe Targets.
@protocol DebugRouterSessionHandler <NSObject>

@required

- (void)onSessionCreate:(int)target_id withUrl:(NSString *)url;
- (void)onSessionDestroy:(int)target_id;
- (void)onMessage:(NSString *)message withType:(NSString *)type withSessionId:(int)target_id;

@end

NS_ASSUME_NONNULL_END
