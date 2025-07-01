// Copyright 2013 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
// Copyright 2022 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_MAKE_COPYABLE_H_
#define DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_MAKE_COPYABLE_H_

#include <utility>

#include "debug_router/native/harmony/base/fml/memory/ref_counted.h"
#include "debug_router/native/harmony/base/fml/memory/ref_ptr.h"

namespace debugrouter {
namespace fml {
namespace internal {

template <typename T>
class CopyableLambda {
 public:
  // TODO(chenyouhui): Merge ref_counted. It will conflict with each other!
  explicit CopyableLambda(T func)
      : impl_(debugrouter::fml::MakeRefCounted<Impl>(std::move(func))) {}

  template <typename... ArgType>
  auto operator()(ArgType&&... args) const {
    return impl_->func_(std::forward<ArgType>(args)...);
  }

 private:
  class Impl : public RefCountedThreadSafe<Impl> {
   public:
    explicit Impl(T func) : func_(std::move(func)) {}
    T func_;
  };

  RefPtr<Impl> impl_;
};

}  // namespace internal

// Provides a wrapper for a move-only lambda that is implictly convertable to an
// std::function.
//
// std::function is copyable, but if a lambda captures an argument with a
// move-only type, the lambda itself is not copyable. In order to use the lambda
// in places that accept std::functions, we provide a copyable object that wraps
// the lambda and is implicitly convertable to an std::function.
//
// EXAMPLE:
//
// std::unique_ptr<Foo> foo = ...
// std::function<int()> func =
//     fml::MakeCopyable([bar = std::move(foo)]() { return bar->count(); });
//
// Notice that the return type of MakeCopyable is rarely used directly. Instead,
// callers typically erase the type by implicitly converting the return value
// to an std::function.
template <typename T>
internal::CopyableLambda<T> MakeCopyable(T lambda) {
  return internal::CopyableLambda<T>(std::move(lambda));
}

}  // namespace fml
}  // namespace debugrouter

namespace fml {
using debugrouter::fml::MakeCopyable;
}

#endif  // DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_MAKE_COPYABLE_H_
