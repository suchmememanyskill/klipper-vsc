import * as vscode from 'vscode';
import WebSocket from 'ws';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export class MoonrakerClient implements vscode.Disposable {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  public constructor(
    private readonly url: string,
    private readonly output: vscode.OutputChannel | undefined
  ) {}

  public get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public connect(): Promise<void> {
    this.disposeSocket();

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      const failTimer = setTimeout(() => {
        reject(new Error('Connection timed out.'));
        socket.close();
      }, 10000);

      socket.once('open', () => {
        clearTimeout(failTimer);
        this.output?.appendLine(`Moonraker WebSocket connected: ${this.url}`);
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(failTimer);
        reject(error);
      });

      socket.on('message', (data) => this.handleMessage(data.toString()));
      socket.on('close', () => {
        this.rejectAll(new Error('Moonraker WebSocket closed.'));
        this.output?.appendLine('Moonraker WebSocket closed.');
      });
    });
  }

  public call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.isConnected || !this.socket) {
      return Promise.reject(new Error('Moonraker is not connected.'));
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      method,
      params: params ?? {},
      id
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Moonraker call timed out: ${method}`));
      }, 15000);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });

      this.socket?.send(JSON.stringify(payload), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  public dispose(): void {
    this.disposeSocket();
    this.rejectAll(new Error('Moonraker client disposed.'));
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      this.output?.appendLine(`Ignoring non-JSON Moonraker message: ${raw}`);
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Moonraker error ${message.error.code ?? ''}`.trim()));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private disposeSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = undefined;
    }
  }
}
