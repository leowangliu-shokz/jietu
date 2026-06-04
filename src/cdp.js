export class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.eventListeners = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => {
        reject(new Error("CDP socket error."));
      }, { once: true });
    });

    this.socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.id && this.pending.has(payload.id)) {
        const { resolve, reject } = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        if (payload.error) {
          reject(new Error(payload.error.message || "CDP command failed."));
        } else {
          resolve(payload.result || {});
        }
        return;
      }

      if (payload.method) {
        if (this.eventListeners.has(payload.method)) {
          for (const listener of this.eventListeners.get(payload.method)) {
            try {
              listener(payload.params || {});
            } catch {
              // Event listeners are observational; they must not break CDP command handling.
            }
          }
        }
        if (this.eventWaiters.has(payload.method)) {
          const waiters = this.eventWaiters.get(payload.method);
          this.eventWaiters.delete(payload.method);
          for (const resolve of waiters) {
            resolve(payload.params || {});
          }
        }
      }
    });

    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP socket closed."));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(message);
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) || [];
        this.eventWaiters.set(method, waiters.filter((waiter) => waiter !== wrappedResolve));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      const wrappedResolve = (payload) => {
        clearTimeout(timer);
        resolve(payload);
      };

      const waiters = this.eventWaiters.get(method) || [];
      waiters.push(wrappedResolve);
      this.eventWaiters.set(method, waiters);
    });
  }

  on(method, listener) {
    const listeners = this.eventListeners.get(method) || [];
    listeners.push(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      const current = this.eventListeners.get(method) || [];
      const next = current.filter((item) => item !== listener);
      if (next.length) {
        this.eventListeners.set(method, next);
      } else {
        this.eventListeners.delete(method);
      }
    };
  }

  close() {
    this.socket.close();
  }
}
