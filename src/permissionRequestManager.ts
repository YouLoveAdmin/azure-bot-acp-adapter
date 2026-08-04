import { PermissionRequest } from "./types/websocket";

/**
 * Permission Request State
 */
interface PendingPermissionRequest {
  requestId: string | number;
  permission: string;
  description?: string;
  requestTime: number;
  timeoutMs: number;
  resolve: (outcome: "approved" | "cancelled" | "denied") => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Permission Request Manager
 *
 * Handles permission requests from the backend:
 * - Queues and manages concurrent permission requests
 * - Tracks timeout for permission responses
 * - Routes to external handler (e.g., user confirmation UI)
 * - Sends responses back to backend
 */
export class PermissionRequestManager {
  private pendingRequests: Map<string, PendingPermissionRequest> = new Map();
  private requestQueue: string[] = [];
  private defaultTimeoutMs: number = 30000; // 30 seconds
  private externalHandler?: (permission: PermissionRequest) => Promise<"approved" | "cancelled" | "denied">;

  /**
   * Register external handler for permission requests
   * (e.g., Teams bot sending Adaptive Card or text prompt to user)
   */
  setExternalHandler(
    handler: (permission: PermissionRequest) => Promise<"approved" | "cancelled" | "denied">
  ): void {
    this.externalHandler = handler;
  }

  /**
   * Handle incoming permission request from backend
   * Routes to external handler and waits for response
   */
  async handlePermissionRequest(
    requestId: string | number,
    request: PermissionRequest,
    timeoutMs?: number
  ): Promise<"approved" | "cancelled" | "denied"> {
    const requestKey = String(requestId);
    const timeout = timeoutMs || this.defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestKey);
        this.removeFromQueue(requestKey);
        reject(new Error(`Permission request timeout (${timeout}ms)`));
      }, timeout);

      const pendingRequest: PendingPermissionRequest = {
        requestId,
        permission: request.permission,
        description: request.description,
        requestTime: Date.now(),
        timeoutMs: timeout,
        resolve: (outcome) => {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(requestKey);
          this.removeFromQueue(requestKey);
          resolve(outcome);
        },
        reject: (error) => {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(requestKey);
          this.removeFromQueue(requestKey);
          reject(error);
        },
        timeout: timeoutHandle
      };

      this.pendingRequests.set(requestKey, pendingRequest);
      this.requestQueue.push(requestKey);

      // Call external handler if available
      if (this.externalHandler) {
        this.externalHandler(request)
          .then((outcome) => {
            pendingRequest.resolve(outcome);
          })
          .catch((error) => {
            console.error("Permission request handler error:", error);
            pendingRequest.reject(error);
          });
      } else {
        // No external handler - default to denial
        console.warn("No external handler for permission request, defaulting to denial");
        pendingRequest.resolve("denied");
      }
    });
  }

  /**
   * Respond to a permission request
   * (typically called after user provides input)
   */
  respondToPermission(requestId: string | number, outcome: "approved" | "cancelled" | "denied"): boolean {
    const requestKey = String(requestId);
    const pending = this.pendingRequests.get(requestKey);

    if (!pending) {
      console.warn(`Permission request not found: ${requestKey}`);
      return false;
    }

    pending.resolve(outcome);
    return true;
  }

  /**
   * Get pending permission request details
   */
  getPendingRequest(requestId: string | number): { permission: string; description?: string } | null {
    const pending = this.pendingRequests.get(String(requestId));
    if (!pending) return null;

    return {
      permission: pending.permission,
      description: pending.description
    };
  }

  /**
   * Get all pending requests
   */
  getPendingRequests(): Array<{
    requestId: string | number;
    permission: string;
    description?: string;
    elapsedMs: number;
  }> {
    const now = Date.now();
    return Array.from(this.pendingRequests.values()).map((req) => ({
      requestId: req.requestId,
      permission: req.permission,
      description: req.description,
      elapsedMs: now - req.requestTime
    }));
  }

  /**
   * Cancel a permission request
   */
  cancelRequest(requestId: string | number): boolean {
    const requestKey = String(requestId);
    const pending = this.pendingRequests.get(requestKey);

    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    pending.resolve("cancelled");
    return true;
  }

  /**
   * Cancel all pending requests
   */
  cancelAllRequests(): number {
    const keys = Array.from(this.pendingRequests.keys());
    keys.forEach((key) => {
      this.cancelRequest(key);
    });
    return keys.length;
  }

  /**
   * Remove request from queue
   */
  private removeFromQueue(requestKey: string): void {
    const index = this.requestQueue.indexOf(requestKey);
    if (index >= 0) {
      this.requestQueue.splice(index, 1);
    }
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.requestQueue.length;
  }

  /**
   * Set default timeout for all new requests
   */
  setDefaultTimeout(timeoutMs: number): void {
    this.defaultTimeoutMs = timeoutMs;
  }
}
