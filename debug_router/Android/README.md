```gradle
// Add DebugRouter dependency to your build.gradle file
dependencies {
    implementation 'org.lynxsdk.lynx:debug-router:${latest_version}'
}
```

```java
import com.lynx.debugrouter.DebugRouter;

// Add DebugRouter instance to your code,
// for example: add in the onCreate method of your Application class
public class DemoApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        DebugRouter.getInstance();
    }
    // ...
}
```