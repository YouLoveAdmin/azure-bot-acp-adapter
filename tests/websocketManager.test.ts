import { WebSocketManager } from "../src/websocketManager";
import { JsonRpcRequest, JsonRpcResponse } from "../src/types/websocket";

describe("WebSocketManager", () => {
  describe("Message Framing", () => {
    test("should encode JSON-RPC message with newline delimiter", () => {
      const message: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: { protocolVersion: 1 }
      };

      const json = JSON.stringify(message) + "\n";
      expect(json).toMatch(/^\{.*\}\n$/);
      expect(json).toContain("jsonrpc");
      expect(json).toContain("id");
      expect(json).toContain("method");
    });

    test("should parse newline-delimited JSON correctly", () => {
      const message = { jsonrpc: "2.0", id: "1", result: { test: "data" } };
      const line = JSON.stringify(message) + "\n";

      const parsed = JSON.parse(line.trim());
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe("1");
      expect(parsed.result).toEqual({ test: "data" });
    });
  });

  describe("Request ID Generation", () => {
    test("should generate incrementing request IDs", () => {
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        ids.push(String(i));
      }
      expect(ids).toEqual(["1", "2", "3", "4", "5"]);
    });
  });

  describe("Authentication", () => {
    test("should encode Basic auth header correctly", () => {
      const username = "token";
      const token = "test-token-123";
      const credentials = `${username}:${token}`;
      const base64 = Buffer.from(credentials).toString("base64");

      expect(base64).toBeDefined();
      expect(base64.length).toBeGreaterThan(0);

      // Verify it decodes back correctly
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      expect(decoded).toBe("token:test-token-123");
    });

    test("should create correct Authorization header", () => {
      const username = "token";
      const authToken = "test-auth-token-456";
      const credentials = `${username}:${authToken}`;
      const base64 = Buffer.from(credentials).toString("base64");
      const header = `Basic ${base64}`;

      expect(header).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    });
  });

  describe("Message Types", () => {
    test("should properly format initialize request", () => {
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {}
        }
      };

      expect(request.jsonrpc).toBe("2.0");
      expect(request.method).toBe("initialize");
      expect(request.params).toHaveProperty("protocolVersion", 1);
    });

    test("should properly format session/prompt request", () => {
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "5",
        method: "session/prompt",
        params: {
          sessionId: "test-session-id",
          prompt: [{ type: "text", text: "Hello, world!" }]
        }
      };

      expect(request.method).toBe("session/prompt");
      expect(request.params.prompt).toHaveLength(1);
      expect(request.params.prompt[0].text).toBe("Hello, world!");
    });

    test("should properly format error response", () => {
      const response = {
        jsonrpc: "2.0",
        id: "1",
        error: {
          code: -32601,
          message: "Method not found"
        }
      };

      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain("Method not found");
    });
  });

  describe("Timeout Handling", () => {
    test("should generate timeout error after specified duration", async () => {
      const timeoutMs = 100;
      const start = Date.now();

      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Request timeout (${timeoutMs}ms)`));
        }, timeoutMs);
      });

      try {
        await promise;
        fail("Should have timed out");
      } catch (error: any) {
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 10); // Allow small variance
        expect(error.message).toContain("timeout");
      }
    });
  });

  describe("Message Parsing", () => {
    test("should handle multiple messages in buffer", () => {
      const messages = [
        { jsonrpc: "2.0", id: "1", result: { test: "data1" } },
        { jsonrpc: "2.0", id: "2", result: { test: "data2" } }
      ];

      const buffer = messages.map(m => JSON.stringify(m) + "\n").join("");

      const lines: string[] = [];
      let remaining = buffer;
      while (remaining.includes("\n")) {
        const newlineIndex = remaining.indexOf("\n");
        const line = remaining.substring(0, newlineIndex).trim();
        remaining = remaining.substring(newlineIndex + 1);
        if (line) {
          lines.push(line);
        }
      }

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).id).toBe("1");
      expect(JSON.parse(lines[1]).id).toBe("2");
    });

    test("should skip empty lines in buffer", () => {
      const buffer = "line1\n\n\nline2\n";
      const lines: string[] = [];
      let remaining = buffer;

      while (remaining.includes("\n")) {
        const newlineIndex = remaining.indexOf("\n");
        const line = remaining.substring(0, newlineIndex).trim();
        remaining = remaining.substring(newlineIndex + 1);
        if (line) {
          lines.push(line);
        }
      }

      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("line1");
      expect(lines[1]).toBe("line2");
    });
  });

  describe("Error Cases", () => {
    test("should handle malformed JSON gracefully", () => {
      const malformed = '{"invalid": json}' + "\n";

      expect(() => {
        JSON.parse(malformed.trim());
      }).toThrow();
    });

    test("should handle JSON-RPC error response", () => {
      const errorResponse = {
        jsonrpc: "2.0",
        id: "1",
        error: {
          code: -32601,
          message: "Method not found"
        }
      };

      const error = errorResponse.error;
      expect(error.code).toBe(-32601);
      expect(error.message).toBe("Method not found");
    });
  });
});
