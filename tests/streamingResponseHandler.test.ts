import test from "node:test";
import assert from "node:assert/strict";
import { StreamingResponseHandler } from "../src/streamingResponseHandler";

test("StreamingResponseHandler captures text from completion payloads", () => {
  const handler = new StreamingResponseHandler();

  handler.handleUpdate({
    sessionUpdate: "agent_message_completion",
    content: {
      type: "json",
      json: null,
      text: "completed text"
    }
  } as any);

  const response = handler.getResponse();
  assert.equal(response.text, "completed text");
});

test("StreamingResponseHandler captures nested text arrays", () => {
  const handler = new StreamingResponseHandler();

  handler.handleUpdate({
    sessionUpdate: "agent_message",
    content: {
      type: "json",
      json: {
        messages: [
          { text: "Hello" },
          { content: { text: " world" } }
        ]
      }
    }
  } as any);

  const response = handler.getResponse();
  assert.equal(response.text, "Hello world");
});
