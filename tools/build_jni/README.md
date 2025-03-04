How to use the JNI header generating scripts ("./tools/build_jni/prebuild_jni.sh")

- Ensure that you have correctly set up your python3 environment.
- Navigate to the script: "./tools/prebuild_jni.sh". Ensure the two primary variables `ANDROID_NAME` and `LIBRARY_NAME` are correctly set by confirming the following:
  - The Java file for which you want to generate a JNI header is located within one of the paths specified in `ANDROID_NAME`.
  - The matching `LIBRARY_NAME` path will be where the generated JNI headers will be stored. The JNI headers can be found at `${LIBRARY_NAME}/build/gen/**`.
  - If the Java file doesn't exist within these paths, add its path to `ANDROID_NAME` and its destination path to `LIBRARY_NAME`.
- Open or create: ${LIBRARY_NAME}/build/jni_files.
  -  Add the path of the Java file, e.g., `com/XX/XX/VideoAsset.java` for `VideoAsset.java` in the `com.XX.XX.player` package.
- Execute the script using: `./tools/prebuild_jni.sh`.
- Look for the generated JNI header file, which will have a `_jni.h` suffix in `${LIBRARY_NAME}/build/gen/**`.
- The generated header file will not be formatted. However, it won't be rejected by git lynx check if left unformatted. We have to format it manually using clang-format (to use clang-format, ensure that you have already `source ./tool/envsetup.h`): 

```
clang-format -i format ./[header_name]_jni.h
```
 
- If you are generating the JNI header for this Java file (or class) for the first time, ensure you invoke the `RegisterNativesImpl` within the shared object (so) loading function. Typically, this loading function can be found in files named "[Library]SoLoad.cc" with signature `extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved)`;