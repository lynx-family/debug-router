```ruby
# add DebugRouter to your Podfile
pod 'DebugRouter', '${latest_version}'
```

```objectivec
#import <DebugRouter/DebugRouter.h>
// add [DebugRouter instance] to your code, 
// for example: add in the didFinishLaunchingWithOptions method
- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  [DebugRouter instance];
  return YES;
}
```
