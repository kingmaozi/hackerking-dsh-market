/**
 * 零依赖 Chrome DevTools Protocol 客户端：用 Node 22+ 的全局 WebSocket 直连 CDP。
 * 只处理 Node/DSH 侧需要的子集：命令、响应、超时、错误、关闭。
 */

export class CdpError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export class CdpConnection {
  /**
   * @param {WebSocket} socket 已打开或正在打开的 WebSocket
   * @param {{timeoutMs?: number}} options
   */
  constructor(socket, { timeoutMs = 30000 } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeReason = '';
    this._listeners = new Map();

    socket.addEventListener('message', (event) => this._onMessage(event));
    socket.addEventListener('close', () => this._onClose('WebSocket 已关闭'));
    socket.addEventListener('error', () => this._onClose('WebSocket 连接错误'));
  }

  /** 建立连接并等待 open。 */
  static async connect(url, { timeoutMs = 15000, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== 'function') {
      throw new CdpError('当前 Node 没有全局 WebSocket，需要 Node >= 22');
    }
    const socket = new WebSocketImpl(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new CdpError(`连接 CDP 超时（${timeoutMs}ms）：${url}`));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError(`无法连接 CDP：${url}`));
      }, { once: true });
    });
    return new CdpConnection(socket, { timeoutMs });
  }

  _onMessage(event) {
    const raw = typeof event.data === 'string' ? event.data : String(event.data);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // 非 JSON 帧直接忽略
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(new CdpError(
          `${entry.method} 失败：${message.error.message ?? '未知 CDP 错误'}${message.error.data === undefined ? '' : `（${String(message.error.data).slice(0, 300)}）`}`,
          { code: message.error.code, data: message.error.data, method: entry.method },
        ));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    // 事件：分发给订阅者（例如 Page.loadEventFired），没有订阅者就丢弃。
    const handlers = this._listeners.get(message.method);
    if (handlers !== undefined) {
      for (const handler of handlers) {
        try {
          handler(message.params ?? {}, message.sessionId);
        } catch {
          // 订阅者异常不影响连接
        }
      }
    }
  }

  _onClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new CdpError(`${reason}（${entry.method} 未完成）`, { method: entry.method }));
    }
  }

  on(method, handler) {
    const set = this._listeners.get(method) ?? new Set();
    set.add(handler);
    this._listeners.set(method, set);
    return () => set.delete(handler);
  }

  /**
   * 发送一条 CDP 命令。
   * @param {string} method 例如 'Page.navigate'
   * @param {object} params
   * @param {{sessionId?: string, timeoutMs?: number}} options
   */
  send(method, params = {}, { sessionId, timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new CdpError(`${this.closeReason || 'CDP 连接已关闭'}，无法执行 ${method}`));
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} 超时（${effectiveTimeout}ms）`));
      }, effectiveTimeout);
      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload = { id, method, params };
      if (sessionId !== undefined) payload.sessionId = sessionId;
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(`发送 ${method} 失败：${error.message}`));
      }
    });
  }

  /** 关闭底层 WebSocket；不等待服务端。 */
  close() {
    if (this.closed) return;
    this._onClose('CDP 连接已主动关闭');
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}
