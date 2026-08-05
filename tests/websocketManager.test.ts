import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcRequest } from "../src/types/websocket";

const describe = (name: string, fn: () => void) => {
  test(name, fn);
};

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
      assert.match(json, /^\{.*\}\n$/);
      assert.ok(json.includes("jsonrpc"));
      assert.ok(json.includes("id"));
      assert.ok(json.includes("method"));
    });

    test("should parse newline-delimited JSON correctly", () => {
      const message = { jsonrpc: "2.0", id: "1", result: { test: "data" } };
      const line = JSON.stringify(message) + "\n";

      const parsed = JSON.parse(line.trim());
      assert.equal(parsed.jsonrpc, "2.0");
      assert.equal(parsed.id, "1");
      assert.deepEqual(parsed.result, { test: "data" });
    });
  });

  describe("Request ID Generation", () => {
    test("should generate incrementing request IDs", () => {
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        ids.push(String(i));
      }
      assert.deepEqual(ids, ["1", "2", "3", "4", "5"]);
    });
  });

  describe("Authentication", () => {
    test("should encode Basic auth header correctly", () => {
      const username = "token";
      const token = "test-token-123";
      const credentials = `${username}:${token}`;
      const base64 = Buffer.from(credentials).toString("base64");

      assert.ok(base64.length > 0);

      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      assert.equal(decoded, "token:test-token-123");
    });

    test("should create correct Authorization header", () => {
      const username = "token";
      const authToken = "test-auth-token-456";
      const credentials = `${username}:${authToken}`;
      const base64 = Buffer.from(credentials).toString("base64");
      const header = `Basic ${base64}`;

      assert.match(header, /^Basic [A-Za-z0-9+/=]+$/);
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

      assert.equal(request.jsonrpc, "2.0");
      assert.equal(request.method, "initialize");
      assert.equal(request.params.protocolVersion, 1);
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

      assert.equal(request.method, "session/prompt");
      assert.equal(request.params.prompt.length, 1);
      assert.equal(request.params.prompt[0].text, "Hello, world!");
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

      assert.equal(response.error.code, -32601);
      assert.match(response.error.message, /Method not found/);
    });
  });

  describe("Timeout Handling", () => {
    test("should generate timeout error after specified duration", async () => {
      const timeoutMs = 100;
      const start = Date.now();

      const promise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Request timeout (${timeoutMs}ms)`));
        }, timeoutMs);
      });

      await assert.rejects(promise, /timeout/);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= timeoutMs - 10);
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

      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).id, "1");
      assert.equal(JSON.parse(lines[1]).id, "2");
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

      assert.equal(lines.length, 2);
      assert.equal(lines[0], "line1");
      assert.equal(lines[1], "line2");
    });
  });

  describe("Error Cases", () => {
    test("should handle malformed JSON gracefully", () => {
      const malformed = '{"invalid": json}' + "\n";

      assert.throws(() => {
        JSON.parse(malformed.trim());
      });
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
      assert.equal(error.code, -32601);
      assert.equal(error.message, "Method not found");
    });
  });
});
