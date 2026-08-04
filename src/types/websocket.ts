/**
 * JSON-RPC 2.0 Protocol Types
 * Based on: https://www.jsonrpc.org/specification
 */

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: any;
  id?: string | number;
}

/**
 * JSON-RPC 2.0 Response (Success)
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: any;
  id?: string | number;
}

/**
 * JSON-RPC 2.0 Error
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

/**
 * JSON-RPC 2.0 Response (Error)
 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  error: JsonRpcError;
  id?: string | number;
}

/**
 * JSON-RPC 2.0 Notification (no id, no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

/**
 * Union of all possible JSON-RPC messages
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcErrorResponse | JsonRpcNotification;

/**
 * Backend Initialize Response
 */
export interface InitializeResult {
  protocolVersion: number;
  authMethods?: AuthMethod[];
  agentCapabilities?: {
    auth?: {
      logout?: boolean;
    };
    loadSession?: boolean;
  };
}

export interface AuthMethod {
  id: string;
  name?: string;
  description?: string;
}

/**
 * Session Results
 */
export interface SessionNewResult {
  sessionId: string;
}

export interface SessionLoadResult {
  sessionId: string;
}

export interface SessionResumeResult {
  sessionId: string;
}

export interface SessionConfigResult {
  configOptions?: ConfigOption[];
}

export interface ConfigOption {
  id: string;
  currentValue?: string;
  availableValues?: string[];
}

/**
 * Session Prompt Result
 */
export interface SessionPromptResult {
  stopReason: "completion" | "stop" | "length" | "error" | "timeout";
  exitCode?: number;
}

/**
 * Session Update (Server-pushed message)
 */
export interface SessionUpdate {
  sessionId?: string;
  sessionUpdate:
    | "agent_message_chunk"
    | "agent_message_completion"
    | "tool_call"
    | "session_state_change"
    | "session_error"
    | "available_commands_update"
    | "config_option_update"
    | "tool_call_update";
  content?: {
    type: "text" | "json" | "image" | "audio";
    text?: string;
    json?: any;
    commands?: any[];
    option?: any;
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Permission Request (Server-pushed message)
 */
export interface PermissionRequest {
  permission: string;
  description?: string;
}

/**
 * Permission Response
 */
export interface PermissionResponse {
  outcome: {
    outcome: "approved" | "cancelled" | "denied";
  };
}

/**
 * WebSocket Manager Options
 */
export interface WebSocketManagerOptions {
  url: string;
  username: string;
  authToken: string;
  connectTimeoutMs?: number;
  messageTimeoutMs?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
}

/**
 * Pending Request State
 */
export interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
}
