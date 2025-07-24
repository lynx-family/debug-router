// Copyright 2013 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Copyright 2022 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

// Internal implementation details for ref_counted.h.

#ifndef DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_MEMORY_REF_COUNTED_INTERNAL_H_
#define DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_MEMORY_REF_COUNTED_INTERNAL_H_

#include <atomic>

#include "debug_router/native/harmony/base/fml/macros.h"

namespace debugrouter {
namespace fml {
namespace internal {

// See ref_counted.h for comments on the public methods.
class RefCountedThreadSafeBase {
 public:
  void AddRef() const {
#ifndef NDEBUG
    // TODO: Uncomment DCHECK code when DCHECK available.
    // DCHECK(!adoption_required_);
    // DCHECK(!destruction_started_);
#endif
    ref_count_.fetch_add(1u, std::memory_order_relaxed);
  }

  bool HasOneRef() const {
    return ref_count_.load(std::memory_order_acquire) == 1u;
  }

  void AssertHasOneRef() const { HasOneRef(); }

  // Returns the current reference count (with no barriers). This is subtle, and
  // should be used only for debugging.
  int SubtleRefCountForDebug() const {
    return ref_count_.load(std::memory_order_relaxed);
  }

 protected:
  RefCountedThreadSafeBase();
  ~RefCountedThreadSafeBase();

  // Returns true if the object should self-delete.
  bool Release() const {
#ifndef NDEBUG
    // TODO: Uncomment DCHECK code when DCHECK available.
    // DCHECK(!adoption_required_);
    // DCHECK(!destruction_started_);
#endif
    // TODO: Uncomment DCHECK code when DCHECK available.
    // DCHECK(ref_count_.load(std::memory_order_acquire) != 0u);
    // TODO(vtl): We could add the following:
    //     if (ref_count_.load(std::memory_order_relaxed) == 1u) {
    // #ifndef NDEBUG
    //       destruction_started_= true;
    // #endif
    //       return true;
    //     }
    // This would be correct. On ARM (an Nexus 4), in *single-threaded* tests,
    // this seems to make the destruction case marginally faster (barely
    // measurable), and while the non-destruction case remains about the same
    // (possibly marginally slower, but my measurements aren't good enough to
    // have any confidence in that). I should try multithreaded/multicore tests.
    if (ref_count_.fetch_sub(1u, std::memory_order_release) == 1u) {
      std::atomic_thread_fence(std::memory_order_acquire);
#ifndef NDEBUG
      destruction_started_ = true;
#endif
      return true;
    }
    return false;
  }

#ifndef NDEBUG
  void Adopt() {
    // TODO: Uncomment DCHECK code when DCHECK available.
    // DCHECK(adoption_required_);
    adoption_required_ = false;
  }
#endif

 protected:
  union {
    struct {
      mutable std::atomic_uint32_t ref_count_;

      // Because subclass of RefCountedThreadSafeBase contains vtable, on 64-bit
      // platforms, 4 bytes of free space are left here.
      union {
        [[maybe_unused]] uint8_t __padding_chars__[4];
        [[maybe_unused]] uint16_t __padding_shorts__[2];
        [[maybe_unused]] uint32_t __padding__;
      };
    };

    // Use `__init__` to fast initialize `ref_count_` to 1 and `__padding__` to
    // 0. Testing results with Clang on Arm64:
    //
    //    1. Initialize by `ref_count_(1), __padding__(0)`.
    //      0x100003e0c <+32>: adrp   x8, 0
    //      0x100003e10 <+36>: ldr    d0, [x8, #0xf00]
    //      0x100003e14 <+40>: str    d0, [x0, #0x8]
    //      0x100003e18 <+44>: adrp   x8, 1
    //      0x100003e1c <+48>: add    x8, x8, #0x38   ; vtable
    //      0x100003e20 <+52>: str    x8, [x0]
    //    Loads combined value of `ref_count_` and `__padding__` from DATA
    //    section as 64bit to register d0 and then stores to x0[0x8]
    //
    //    2. Initialize with single `__init__(1)`.
    //      0x100003e20 <+32>: adrp   x8, 1
    //      0x100003e24 <+36>: add    x8, x8, #0x38   ; vtable
    //      0x100003e28 <+40>: mov    w9, #0x1        ; =1
    //      0x100003e2c <+44>: stp    x8, x9, [x0]
    //    No loading of combined value from memory and stores to x0 together
    //    with vtable using single stp instruction.
    uint64_t __init__;
  };

#ifndef NDEBUG
  mutable bool adoption_required_;
  mutable bool destruction_started_;
#endif

  BASE_DISALLOW_COPY_AND_ASSIGN(RefCountedThreadSafeBase);
};

inline RefCountedThreadSafeBase::RefCountedThreadSafeBase()
    : __init__(1u)
#ifndef NDEBUG
      ,
      adoption_required_(true),
      destruction_started_(false)
#endif
{
}

inline RefCountedThreadSafeBase::~RefCountedThreadSafeBase() {
#ifndef NDEBUG
  // TODO: Uncomment DCHECK code when DCHECK available.
  // DCHECK(!adoption_required_);
  // Should only be destroyed as a result of |Release()|.
  // DCHECK(destruction_started_);
#endif
}

}  // namespace internal
}  // namespace fml
}  // namespace debugrouter

#endif  // DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_MEMORY_REF_COUNTED_INTERNAL_H_
