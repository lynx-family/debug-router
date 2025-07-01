<div>

## Introduction

PrimJS is a lightweight, high-performance JavaScript engine designed specifically for the [Lynx](https://github.com/lynx-family/lynx) cross-platform framework. Fully supporting ES2019, PrimJS is built on top of [QuickJS](https://bellard.org/quickjs/) and delivers superior performance and a better development experience compared to QuickJS.

## Installation

```bash
ohpm install @lynx/debug_router
```

## How to use

As the underlying JS engine of Lynx, PrimJS currently has no scenarios for independent integration or usage. For apps that need to integrate Lynx, they must simultaneously introduce the PrimJS dependency.

You can add dependency in oh-package.json5 like this:

```json5
{
  "dependencies": {
    "@lynx/debug_router": "0.0.1",
  }
}
```
</div>
