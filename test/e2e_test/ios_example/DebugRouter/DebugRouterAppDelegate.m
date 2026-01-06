// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterAppDelegate.h"
#import "DebugRouter.h"

@implementation DebugRouterAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  // Override point for customization after application launch.
  [[DebugRouter instance] enableAllSessions];
  return YES;
}

- (UISceneConfiguration *)application:(UIApplication *)application
    configurationForConnectingSceneSession:(UISceneSession *)connectingSceneSession
                                   options:(UISceneConnectionOptions *)options {
  // Called when a new scene session is being created.
  // Use this method to select a configuration to create the new scene with.
  return [[UISceneConfiguration alloc] initWithName:@"Default Configuration"
                                        sessionRole:connectingSceneSession.role];
}

- (void)applicationWillResignActive:(UIApplication *)application {
  // Sent when the application is about to move from active to inactive state.
  // This can occur for certain types of temporary interruptions (such as an
  // incoming phone call or SMS message) or when the user quits the application
  // and it begins the transition to the background state. Use this method to
  // pause ongoing tasks, disable timers, and throttle down OpenGL ES frame
  // rates. Games should use this method to pause the game.
  NSLog(@"DebugRouter: applicationWillResignActive");
  NSLog(@"%lu", (unsigned long)[[DebugRouter instance] connection_state]);
}

- (void)applicationDidEnterBackground:(UIApplication *)application {
  // Use this method to release shared resources, save user data, invalidate
  // timers, and store enough application state information to restore your
  // application to its current state in case it is terminated later. If your
  // application supports background execution, this method is called instead of
  // applicationWillTerminate: when the user quits.
  NSLog(@"DebugRouter: applicationDidEnterBackground");
  NSLog(@"%lu", (unsigned long)[[DebugRouter instance] connection_state]);
}

- (void)applicationWillEnterForeground:(UIApplication *)application {
  // Called as part of the transition from the background to the inactive state;
  // here you can undo many of the changes made on entering the background.
  NSLog(@"DebugRouter: applicationWillEnterForeground");
  NSLog(@"%lu", (unsigned long)[[DebugRouter instance] connection_state]);
}

- (void)applicationDidBecomeActive:(UIApplication *)application {
  // Restart any tasks that were paused (or not yet started) while the
  // application was inactive. If the application was previously in the
  // background, optionally refresh the user interface.
  NSLog(@"DebugRouter: applicationDidBecomeActive");
  NSLog(@"%lu", (unsigned long)[[DebugRouter instance] connection_state]);
}

- (void)applicationWillTerminate:(UIApplication *)application {
  // Called when the application is about to terminate. Save data if
  // appropriate. See also applicationDidEnterBackground:.
  NSLog(@"DebugRouter: applicationWillTerminate");
  NSLog(@"%lu", (unsigned long)[[DebugRouter instance] connection_state]);
}

@end
