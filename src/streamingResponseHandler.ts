import { SessionUpdate } from "./types/websocket";

/**
 * Streaming Response Handler
 *
 * Buffers and processes session/update messages received from the backend.
 * Since Teams bot sends discrete messages, streaming is buffered until complete.
 */
export class StreamingResponseHandler {
  private textBuffer: string[] = [];
  private toolCalls: any[] = [];
  private sessionStateChanges: any[] = [];
  private errors: any[] = [];
  private isComplete: boolean = false;

  /**
   * Handle a session/update message from the backend
   */
  handleUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.handleMessageChunk(update);
        break;

      case "agent_message_completion":
        this.handleMessageCompletion(update);
        break;

      case "tool_call":
        this.handleToolCall(update);
        break;

      case "session_state_change":
        this.handleSessionStateChange(update);
        break;

      case "session_error":
        this.handleSessionError(update);
        break;

      case "available_commands_update":
        // Backend sends available commands after session creation
        console.log("Available commands updated:", update.content?.commands);
        break;

      case "config_option_update":
        // Backend sends config options after session creation
        console.log("Config option updated:", update.content?.option);
        break;

      case "tool_call_update":
        // Backend sends intermediate tool call updates
        console.log("Tool call update:", update.content);
        break;

      default:
        console.warn(`Unknown session update type: ${(update as any).sessionUpdate}`);
    }
  }

  /**
   * Handle agent message chunk (streaming text)
   */
  private handleMessageChunk(update: SessionUpdate): void {
    if (update.content?.type === "text" && update.content.text) {
      this.textBuffer.push(update.content.text);
    }
  }

  /**
   * Handle agent message completion marker
   */
  private handleMessageCompletion(update: SessionUpdate): void {
    // Mark streaming as complete for this batch
    console.log("Agent message completed");
  }

  /**
   * Handle tool call notification
   */
  private handleToolCall(update: SessionUpdate): void {
    if (update.content?.json) {
      this.toolCalls.push({
        timestamp: Date.now(),
        content: update.content.json
      });
      console.log("Tool call received:", update.content.json);
    }
  }

  /**
   * Handle session state change notification
   */
  private handleSessionStateChange(update: SessionUpdate): void {
    if (update.content?.json) {
      this.sessionStateChanges.push({
        timestamp: Date.now(),
        state: update.content.json
      });
      console.log("Session state changed:", update.content.json);
    }
  }

  /**
   * Handle session error notification
   */
  private handleSessionError(update: SessionUpdate): void {
    if (update.error) {
      this.errors.push({
        timestamp: Date.now(),
        code: update.error.code,
        message: update.error.message
      });
      console.error("Session error:", update.error);
    }
  }

  /**
   * Get the complete text response (concatenated chunks)
   */
  getText(): string {
    return this.textBuffer.join("");
  }

  /**
   * Get the complete response as structured data
   */
  getResponse(): {
    text: string;
    toolCalls: any[];
    stateChanges: any[];
    errors: any[];
  } {
    return {
      text: this.getText(),
      toolCalls: this.toolCalls,
      stateChanges: this.sessionStateChanges,
      errors: this.errors
    };
  }

  /**
   * Clear buffered data (call after sending response to user)
   */
  reset(): void {
    this.textBuffer = [];
    this.toolCalls = [];
    this.sessionStateChanges = [];
    this.errors = [];
    this.isComplete = false;
  }

  /**
   * Check if there were any errors
   */
  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  /**
   * Get first error
   */
  getFirstError(): { code: string; message: string } | null {
    if (this.errors.length === 0) return null;
    return {
      code: this.errors[0].code,
      message: this.errors[0].message
    };
  }
}
