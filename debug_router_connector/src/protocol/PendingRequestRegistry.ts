type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

export class PendingRequestRegistry<T> {
  private readonly requests = new Map<string, PendingRequest<T>>();

  get size(): number {
    return this.requests.size;
  }

  has(key: string): boolean {
    return this.requests.has(key);
  }

  register(key: string, timeoutMs?: number): Promise<T> {
    if (this.requests.has(key)) {
      return Promise.reject(new Error(`Request ${key} is already pending`));
    }

    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest<T> = { resolve, reject };
      if (timeoutMs !== undefined) {
        request.timer = setTimeout(() => {
          this.reject(
            key,
            Object.assign(
              new Error(`Request ${key} timed out after ${timeoutMs}ms`),
              { code: "REQUEST_TIMEOUT" },
            ),
          );
        }, timeoutMs);
      }
      this.requests.set(key, request);
    });
  }

  resolve(key: string, value: T): boolean {
    const request = this.take(key);
    if (!request) {
      return false;
    }
    request.resolve(value);
    return true;
  }

  reject(key: string, error: Error): boolean {
    const request = this.take(key);
    if (!request) {
      return false;
    }
    request.reject(error);
    return true;
  }

  rejectAll(error: Error): void {
    for (const key of Array.from(this.requests.keys())) {
      this.reject(key, error);
    }
  }

  private take(key: string): PendingRequest<T> | undefined {
    const request = this.requests.get(key);
    if (!request) {
      return undefined;
    }
    this.requests.delete(key);
    if (request.timer) {
      clearTimeout(request.timer);
    }
    return request;
  }
}
