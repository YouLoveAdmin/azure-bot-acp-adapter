import WebSocket from "ws";
import {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  WebSocketManagerOptions,
  PendingRequest,
  InitializeResult,
  SessionNewResult,
  SessionLoadResult,
  SessionResumeResult,
  SessionConfigResult,
  SessionPromptResult,
  SessionUpdate,
  PermissionRequest,
  PermissionResponse
} from "./types/websocket";

/**
 * WebSocket Manager for JSON-RPC 2.0 Protocol
 *
 * Handles:
 * - Connection management with authentication
 * - JSON-RPC 2.0 message framing (newline-delimited)
 * - Request ID tracking and response matching
 * - Timeout handling
 * - Server-pushed messages (session/update, session/request_permission)
 * - Message buffering for line-based parsing
 */
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private options: WebSocketManagerOptions;
  private nextRequestId: number = 1;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private messageBuffer: string = "";
  private eventListeners: Map<string, Function[]> = new Map();
  private isConnected: boolean = false;
  private intentionalDisconnect: boolean = false;
  private reconnectAttempts: number = 0;

  constructor(options: WebSocketManagerOptions) {
    const mergedOptions: WebSocketManagerOptions = {
      connectTimeoutMs: 10000,
      messageTimeoutMs: 30000,
      reconnect: true,
      reconnectDelayMs: 2000,
      reconnectMaxDelayMs: 30000,
      ...options
    };

    if (!mergedOptions.connectTimeoutMs || mergedOptions.connectTimeoutMs <= 0) {
      console.warn(`Invalid connectTimeoutMs (${mergedOptions.connectTimeoutMs}); using default 10000ms`);
      mergedOptions.connectTimeoutMs = 10000;
    }

    this.options = mergedOptions;
  }

  /**
   * Connect to the WebSocket backend
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.ws) {
      return;
    }

    return new Promise((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        if (this.ws) {
          this.ws.close();
        }
        reject(new Error(`WebSocket connection timeout (${this.options.connectTimeoutMs}ms)`));
      }, this.options.connectTimeoutMs);

      try {
        // Calculate Basic auth header
        const credentials = `${this.options.username}:${this.options.authToken}`;
        const base64 = Buffer.from(credentials).toString("base64");

        this.ws = new WebSocket(this.options.url, {
          headers: {
            Authorization: `Basic ${base64}`
          }
        });

        this.ws.on("open", () => {
          clearTimeout(connectTimeout);
          this.isConnected = true;
          console.log(`WebSocket connected to ${this.options.url}`);
          resolve();
        });

        this.ws.on("message", (data: Buffer) => {
          this.handleData(data.toString("utf-8"));
        });

        this.ws.on("close", () => {
          const wasConnected = this.isConnected;
          this.isConnected = false;
          this.ws = null;
          console.log("WebSocket disconnected");
          this.emit("disconnected", {});
          if (wasConnected && !this.intentionalDisconnect && this.options.reconnect) {
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (error: Error) => {
          clearTimeout(connectTimeout);
          console.error("WebSocket error:", error);
          reject(error);
        });
      } catch (error) {
        clearTimeout(connectTimeout);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket disconnected"));
    }
    this.pendingRequests.clear();
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async request<T = any>(method: string, params?: any): Promise<T> {
    if (!this.ws || !this.isConnected) {
      throw new Error("WebSocket not connected");
    }

    const id = String(this.nextRequestId++);
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeoutStartedAt = Date.now();
      const timeout = this.options.messageTimeoutMs && this.options.messageTimeoutMs > 0
        ? setTimeout(() => {
          this.pendingRequests.delete(id);
          const elapsedMs = Date.now() - timeoutStartedAt;
          const pendingCount = this.pendingRequests.size;

          if (this.ws && this.isConnected) {
            try {
              this.isConnected = false;
              this.ws.close();
              this.ws = null;
            } catch {
              // Ignore cleanup errors and continue with the rejection.
            }
          }

          reject(new Error(`Request timeout for method "${method}" (id=${id}, elapsedMs=${elapsedMs}, timeoutMs=${this.options.messageTimeoutMs}, pendingAfterDrop=${pendingCount})`));
        }, this.options.messageTimeoutMs)
        : undefined;

      // Store pending request
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout
      });

      // Send message
      try {
        this.sendMessage(message);
      } catch (error) {
        this.pendingRequests.delete(id);
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      }
    });
  }

  /**
   * Register event listener for server-pushed messages
   */
  on(eventName: string, callback: (data: any) => void): void {
    if (!this.eventListeners.has(eventName)) {
      this.eventListeners.set(eventName, []);
    }
    this.eventListeners.get(eventName)!.push(callback);
  }

  /**
   * Remove event listener
   */
  off(eventName: string, callback: (data: any) => void): void {
    const listeners = this.eventListeners.get(eventName);
    if (!listeners) return;

    const index = listeners.indexOf(callback);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  }

  /**
   * Emit event to all registered listeners
   */
  private emit(eventName: string, data: any): void {
    const listeners = this.eventListeners.get(eventName) || [];
    for (const callback of listeners) {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event listener for "${eventName}":`, error);
      }
    }
  }

  /**
   * Send a JSON-RPC message (internal)
   */
  private sendMessage(message: JsonRpcMessage): void {
    if (!this.ws) {
      throw new Error("WebSocket not connected");
    }

    const json = JSON.stringify(message) + "\n";
    this.ws.send(json);
  }

  /**
   * Handle incoming data and parse line-delimited JSON
   */
  private handleData(chunk: string): void {
    this.messageBuffer += chunk;

    // Process all complete lines (newline-delimited)
    while (this.messageBuffer.includes("\n")) {
      const newlineIndex = this.messageBuffer.indexOf("\n");
      const line = this.messageBuffer.substring(0, newlineIndex).trim();
      this.messageBuffer = this.messageBuffer.substring(newlineIndex + 1);

      if (line.length === 0) {
        // Skip empty lines
        continue;
      }

      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        this.handleMessage(message);
      } catch (error) {
        console.error("Failed to parse JSON-RPC message:", error, "Line:", line);
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: JsonRpcMessage): void {
    // Response to a request (with id)
    if ("result" in message || "error" in message) {
      const id = String(message.id);
      const pending = this.pendingRequests.get(id);

      if (pending) {
        this.pendingRequests.delete(id);
        clearTimeout(pending.timeout);

        if ("error" in message) {
          const error = message.error;
          pending.reject(new Error(`[${error.code}] ${error.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Server-initiated message (has method)
    if ("method" in message) {
      const msgWithMethod = message as JsonRpcRequest & JsonRpcNotification;
      
      if (msgWithMethod.method === "session/update") {
        const params = (msgWithMethod as any).params;
        const envelopeSessionId = params?.sessionId ?? params?.session_id;
        const updatePayload = (params?.update ?? params ?? {}) as SessionUpdate & { [key: string]: any };

        if (!updatePayload.sessionId && envelopeSessionId) {
          updatePayload.sessionId = String(envelopeSessionId);
        }

        this.emit("session/update", updatePayload as SessionUpdate);
      } else if (msgWithMethod.method === "session/request_permission") {
        this.emit("session/request_permission", {
          id: msgWithMethod.id,
          params: msgWithMethod.params as PermissionRequest
        });
      } else {
        // Unknown method - send error response if id exists
        if (msgWithMethod.id) {
          this.sendMessage({
            jsonrpc: "2.0",
            id: msgWithMethod.id,
            error: {
              code: -32601,
              message: `Method not found: ${msgWithMethod.method}`
            }
          } as JsonRpcErrorResponse);
        }
      }
    }
  }

  /**
   * Convenience methods for common operations
   */

  async initialize(protocolVersion: number = 1): Promise<InitializeResult> {
    return this.request("initialize", {
      protocolVersion,
      clientCapabilities: {}
    });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.request("authenticate", {
      methodId
    });
  }

  async sessionNew(cwd: string = "/workspace", mcpServers: any[] = []): Promise<SessionNewResult> {
    return this.request("session/new", {
      cwd,
      mcpServers
    });
  }

  async sessionLoad(sessionId: string, cwd: string = "/workspace", mcpServers: any[] = []): Promise<SessionLoadResult> {
    return this.request("session/load", {
      sessionId,
      cwd,
      mcpServers
    });
  }

  async sessionResume(sessionId: string): Promise<SessionResumeResult> {
    return this.request("session/resume", {
      sessionId
    });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigResult> {
    return this.request("session/set_config_option", {
      sessionId,
      configId,
      value
    });
  }

  async sessionPrompt(sessionId: string, text: string): Promise<SessionPromptResult> {
    return this.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text
        }
      ]
    });
  }

  async sessionDestroy(sessionId: string): Promise<void> {
    await this.request("session/destroy", {
      sessionId
    });
  }

  async sendPermissionResponse(requestId: string | number, outcome: "approved" | "cancelled" | "denied"): Promise<void> {
    this.sendMessage({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        outcome: {
          outcome
        }
      }
    } as JsonRpcResponse);
  }

  /**
   * Check if connected
   */
  isReady(): boolean {
    return this.isConnected && this.ws !== null;
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    const maxAttempts = this.options.reconnectMaxAttempts ?? Infinity;
    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`WebSocket reconnect abandoned after ${this.reconnectAttempts} attempt(s)`);
      return;
    }

    const baseDelay = this.options.reconnectDelayMs ?? 2000;
    const maxDelay = this.options.reconnectMaxDelayMs ?? 30000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    this.reconnectAttempts++;

    console.log(`WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectAttempts = 0;
        console.log("WebSocket reconnected successfully");
        this.emit("reconnected", {});
      } catch (error) {
        console.error(`WebSocket reconnect attempt ${this.reconnectAttempts} failed:`, error);
        this.scheduleReconnect();
      }
    }, delay);
  }
}
