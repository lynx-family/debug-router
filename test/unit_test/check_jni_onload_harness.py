#!/usr/bin/env python3
# Copyright 2026 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

import pathlib
import shutil
import subprocess
import sys
import tempfile
import textwrap


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
ANDROID_JNI_CC = (
    REPO_ROOT / "debug_router/native/android/base/android/android_jni.cc"
)
SOLOAD_CC = REPO_ROOT / "debug_router/native/android/DebugRouterSoLoad.cc"


def extract_function(source: str, signature: str) -> str:
    start = source.find(signature)
    if start == -1:
        raise RuntimeError(f"Cannot find signature: {signature}")

    brace_start = source.find("{", start)
    if brace_start == -1:
        raise RuntimeError(f"Cannot find function body for: {signature}")

    depth = 0
    for index in range(brace_start, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]

    raise RuntimeError(f"Cannot parse function body for: {signature}")


def generate_harness_source() -> str:
    attach_fn = extract_function(
        ANDROID_JNI_CC.read_text(),
        "JNIEnv *AttachCurrentThread()",
    )
    onload_fn = extract_function(
        SOLOAD_CC.read_text(),
        'extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved)',
    )

    return textwrap.dedent(
        f"""
        #include <cstring>
        #include <iostream>
        #include <memory>
        #include <string>

        using jint = int;
        using jsize = int;
        using jobject = void*;
        using jclass = void*;
        using jthrowable = void*;

        static constexpr jint JNI_OK = 0;
        static constexpr jint JNI_ERR = -1;
        static constexpr jint JNI_EDETACHED = -2;
        static constexpr jint JNI_VERSION_1_2 = 0x00010002;
        static constexpr jint JNI_VERSION_1_4 = 0x00010004;
        static constexpr jint JNI_VERSION_1_6 = 0x00010006;

        #define JNIEXPORT
        #define PR_GET_NAME 16

        struct FakeJNIEnv {{
          bool valid = true;
        }};

        using JNIEnv = FakeJNIEnv;

        struct JavaVMAttachArgs {{
          jint version;
          const char* name;
          void* group;
        }};

        struct FakeJavaVMState {{
          jint get_env_result = JNI_OK;
          jint attach_result = JNI_OK;
          bool get_env_sets_env = true;
          bool attach_sets_env = true;
          int get_env_calls = 0;
          int attach_calls = 0;
          int detach_calls = 0;
          std::string thread_name = "jni-harness";
          JNIEnv env;
          std::string attached_name;
        }};

        struct JavaVM {{
          FakeJavaVMState* state = nullptr;

          jint GetEnv(void** env, jint version) {{
            (void)version;
            state->get_env_calls++;
            *env = state->get_env_sets_env ? &state->env : nullptr;
            return state->get_env_result;
          }}

          jint AttachCurrentThread(JNIEnv** env, void* args) {{
            state->attach_calls++;
            if (args != nullptr) {{
              auto* attach_args = reinterpret_cast<JavaVMAttachArgs*>(args);
              state->attached_name = attach_args->name ? attach_args->name : "";
            }}
            *env = state->attach_sets_env ? &state->env : nullptr;
            return state->attach_result;
          }}

          jint DetachCurrentThread() {{
            state->detach_calls++;
            return JNI_OK;
          }}
        }};

        int prctl(int option, char* name, unsigned long, unsigned long, unsigned long) {{
          if (option != PR_GET_NAME) {{
            return -1;
          }}
          std::strncpy(name, "jni-harness", 15);
          name[15] = '\\0';
          return 0;
        }}

        namespace debugrouter {{
        namespace test_support {{

        struct RegisterState {{
          bool debug_router_android = true;
          bool native_target = true;
          bool debug_router_listener = true;
          bool debug_router_report = true;
          bool message_handler = true;
          bool debug_router_global_handler = true;
          bool debug_router_target_handler = true;
          bool message_assembler = true;
          bool logging_delegate = true;
          int register_calls = 0;
          int null_env_calls = 0;
        }};

        static RegisterState g_register_state;

        void ResetRegisterState() {{
          g_register_state = RegisterState{{}};
        }}

        bool TrackRegister(JNIEnv* env, bool result) {{
          g_register_state.register_calls++;
          if (env == nullptr) {{
            g_register_state.null_env_calls++;
          }}
          return result && env != nullptr;
        }}

        }}  // namespace test_support

        namespace common {{
        namespace android {{

        struct JNIDetach;
        void DetachFromVM();
        static JavaVM* g_jvm = nullptr;

        void InitVM(JavaVM* vm) {{ g_jvm = vm; }}

        struct JNIDetach {{
          ~JNIDetach() {{ DetachFromVM(); }}
        }};

        static thread_local std::unique_ptr<JNIDetach> tls_jni_detach;

        {attach_fn}

        void DetachFromVM() {{
          if (g_jvm != nullptr) {{
            g_jvm->DetachCurrentThread();
          }}
        }}

        }}  // namespace android
        }}  // namespace common

        namespace android {{

        struct DebugRouterAndroid {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.debug_router_android);
          }}
        }};

        struct NativeTargetAndroid {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.native_target);
          }}
        }};

        struct DebugRouterListenerAndroid {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.debug_router_listener);
          }}
        }};

        struct DebugRouterReportAndroid {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.debug_router_report);
          }}
        }};

        struct MessageHandlerAndroid {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.message_handler);
          }}
        }};

        struct DebugRouterGlobalHandlerAndroid {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.debug_router_global_handler);
          }}
        }};

        struct DebugRouterTargetHandlerAndroid {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.debug_router_target_handler);
          }}
        }};

        struct MessageAssemberJNI {{
          static bool RegisterJNIUtils(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.message_assembler);
          }}
        }};

        }}  // namespace android

        namespace logging {{

        struct LoggingDelegateAndroid {{
          static bool RegisterJNI(JNIEnv* env) {{
            return test_support::TrackRegister(env, test_support::g_register_state.logging_delegate);
          }}
        }};

        }}  // namespace logging

        {onload_fn}

        }}  // namespace debugrouter

        namespace {{

        int Fail(const std::string& message) {{
          std::cerr << "FAIL: " << message << std::endl;
          return 1;
        }}

        int Pass(const std::string& message) {{
          std::cout << "PASS: " << message << std::endl;
          return 0;
        }}

        int RunAttachAlreadyAttached() {{
          FakeJavaVMState state;
          state.get_env_result = JNI_OK;
          state.get_env_sets_env = true;
          JavaVM vm{{&state}};
          debugrouter::common::android::InitVM(&vm);

          auto* env = debugrouter::common::android::AttachCurrentThread();
          if (env != &state.env) {{
            return Fail("AttachCurrentThread should return existing env");
          }}
          if (state.attach_calls != 0) {{
            return Fail("AttachCurrentThread should not attach when GetEnv succeeds");
          }}
          return Pass("AttachCurrentThread reuses attached env");
        }}

        int RunAttachDetachedSuccess() {{
          FakeJavaVMState state;
          state.get_env_result = JNI_EDETACHED;
          state.get_env_sets_env = false;
          state.attach_result = JNI_OK;
          state.attach_sets_env = true;
          JavaVM vm{{&state}};
          debugrouter::common::android::InitVM(&vm);

          auto* env = debugrouter::common::android::AttachCurrentThread();
          if (env != &state.env) {{
            return Fail("AttachCurrentThread should return env after attach");
          }}
          if (state.attach_calls != 1) {{
            return Fail("AttachCurrentThread should attach once when detached");
          }}
          if (state.attached_name != "jni-harness") {{
            return Fail("AttachCurrentThread should propagate thread name");
          }}
          return Pass("AttachCurrentThread attaches detached thread");
        }}

        int RunAttachFailure() {{
          FakeJavaVMState state;
          state.get_env_result = JNI_EDETACHED;
          state.get_env_sets_env = false;
          state.attach_result = JNI_ERR;
          state.attach_sets_env = false;
          JavaVM vm{{&state}};
          debugrouter::common::android::InitVM(&vm);

          auto* env = debugrouter::common::android::AttachCurrentThread();
          if (env != nullptr) {{
            return Fail("AttachCurrentThread should fail with nullptr when attach fails");
          }}
          return Pass("AttachCurrentThread reports attach failure");
        }}

        int RunAttachNullVm() {{
          debugrouter::common::android::InitVM(nullptr);
          auto* env = debugrouter::common::android::AttachCurrentThread();
          if (env != nullptr) {{
            return Fail("AttachCurrentThread should return nullptr when vm is null");
          }}
          return Pass("AttachCurrentThread handles null vm");
        }}

        int RunOnLoadHappy() {{
          FakeJavaVMState state;
          state.get_env_result = JNI_OK;
          state.get_env_sets_env = true;
          JavaVM vm{{&state}};
          debugrouter::test_support::ResetRegisterState();

          jint version = debugrouter::JNI_OnLoad(&vm, nullptr);
          if (version != JNI_VERSION_1_6) {{
            return Fail("JNI_OnLoad should return JNI_VERSION_1_6 on success");
          }}
          if (debugrouter::test_support::g_register_state.register_calls != 9) {{
            return Fail("JNI_OnLoad should register all JNI helpers");
          }}
          return Pass("JNI_OnLoad succeeds in happy path");
        }}

        int RunOnLoadAttachFailureShouldError() {{
          FakeJavaVMState state;
          state.get_env_result = JNI_EDETACHED;
          state.get_env_sets_env = false;
          state.attach_result = JNI_ERR;
          state.attach_sets_env = false;
          JavaVM vm{{&state}};
          debugrouter::test_support::ResetRegisterState();

          jint version = debugrouter::JNI_OnLoad(&vm, nullptr);
          if (version != JNI_ERR) {{
            return Fail("JNI_OnLoad should return JNI_ERR when env acquisition fails");
          }}
          if (debugrouter::test_support::g_register_state.register_calls != 0) {{
            return Fail("JNI_OnLoad should not register helpers when env is null");
          }}
          return Pass("JNI_OnLoad rejects null env");
        }}

        int RunOnLoadRegisterFailureShouldError() {{
          FakeJavaVMState state;
          state.get_env_result = JNI_OK;
          state.get_env_sets_env = true;
          JavaVM vm{{&state}};
          debugrouter::test_support::ResetRegisterState();
          debugrouter::test_support::g_register_state.message_handler = false;

          jint version = debugrouter::JNI_OnLoad(&vm, nullptr);
          if (version != JNI_ERR) {{
            return Fail("JNI_OnLoad should return JNI_ERR when any registration fails");
          }}
          return Pass("JNI_OnLoad rejects partial registration");
        }}

        int RunOnLoadRepeatedCallVersionConsistent() {{
          FakeJavaVMState state;
          state.get_env_result = JNI_OK;
          state.get_env_sets_env = true;
          JavaVM vm{{&state}};
          debugrouter::test_support::ResetRegisterState();

          jint first = debugrouter::JNI_OnLoad(&vm, nullptr);
          jint second = debugrouter::JNI_OnLoad(&vm, nullptr);
          if (first != JNI_VERSION_1_6 || second != JNI_VERSION_1_6) {{
            return Fail("JNI_OnLoad should return a consistent JNI version across repeated calls");
          }}
          if (debugrouter::test_support::g_register_state.register_calls != 9) {{
            return Fail("JNI_OnLoad should early-return on the second call without re-registering");
          }}
          return Pass("JNI_OnLoad repeated calls stay consistent");
        }}

        }}  // namespace

        int main(int argc, char** argv) {{
          if (argc != 2) {{
            std::cerr << "usage: " << argv[0] << " <scenario>" << std::endl;
            return 2;
          }}

          std::string scenario = argv[1];
          if (scenario == "attach_already_attached") {{
            return RunAttachAlreadyAttached();
          }}
          if (scenario == "attach_detached_success") {{
            return RunAttachDetachedSuccess();
          }}
          if (scenario == "attach_failure") {{
            return RunAttachFailure();
          }}
          if (scenario == "attach_null_vm") {{
            return RunAttachNullVm();
          }}
          if (scenario == "onload_happy") {{
            return RunOnLoadHappy();
          }}
          if (scenario == "onload_attach_failure_should_error") {{
            return RunOnLoadAttachFailureShouldError();
          }}
          if (scenario == "onload_register_failure_should_error") {{
            return RunOnLoadRegisterFailureShouldError();
          }}
          if (scenario == "onload_repeated_call_version_consistent") {{
            return RunOnLoadRepeatedCallVersionConsistent();
          }}

          std::cerr << "unknown scenario: " << scenario << std::endl;
          return 2;
        }}
        """
    )


def compile_harness(temp_dir: pathlib.Path) -> pathlib.Path:
    source_path = temp_dir / "jni_onload_harness.cpp"
    binary_path = temp_dir / "jni_onload_harness"
    source_path.write_text(generate_harness_source())

    compiler = shutil.which("clang++") or shutil.which("g++")
    if compiler is None:
        raise RuntimeError("Cannot find clang++ or g++ in PATH")

    subprocess.run(
        [
            compiler,
            "-std=c++17",
            str(source_path),
            "-o",
            str(binary_path),
        ],
        check=True,
        cwd=REPO_ROOT,
    )
    return binary_path


def run_scenario(binary_path: pathlib.Path, scenario: str) -> int:
    result = subprocess.run(
        [str(binary_path), scenario],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
    )
    if result.stdout:
        print(result.stdout.strip())
    if result.stderr:
        print(result.stderr.strip(), file=sys.stderr)
    return result.returncode


def main() -> int:
    scenarios = [
        "attach_already_attached",
        "attach_detached_success",
        "attach_failure",
        "attach_null_vm",
        "onload_happy",
        "onload_attach_failure_should_error",
        "onload_register_failure_should_error",
        "onload_repeated_call_version_consistent",
    ]

    with tempfile.TemporaryDirectory(prefix="jni_onload_harness_") as temp_dir:
        binary_path = compile_harness(pathlib.Path(temp_dir))

        failed = []
        for scenario in scenarios:
            code = run_scenario(binary_path, scenario)
            if code != 0:
                failed.append(scenario)

    if failed:
        print(
            "Scenarios failed: " + ", ".join(failed),
            file=sys.stderr,
        )
        return 1

    print("All JNI harness scenarios passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
