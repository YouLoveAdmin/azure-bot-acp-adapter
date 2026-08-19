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

test("StreamingResponseHandler keeps only JSONL assistant messages without tool requests", () => {
  const handler = new StreamingResponseHandler();

  for (const message of [
    {
      type: "assistant.message",
      data: {
        content: "I'll look up the enrolment form.",
        toolRequests: [{ name: "search" }]
      }
    },
    {
      type: "assistant.message",
      data: {
        content: "I found the relevant document.",
        toolRequests: [{ name: "read" }]
      }
    },
    {
      type: "assistant.message",
      data: {
        content: "- **Policyholder Name:** Kebet Holdings Ltd",
        toolRequests: []
      }
    }
  ]) {
    handler.handleUpdate({
      sessionUpdate: "agent_message",
      content: {
        type: "json",
        json: message
      }
    });
  }

  assert.equal(
    handler.getText(),
    "- **Policyholder Name:** Kebet Holdings Ltd"
  );
});

test("StreamingResponseHandler accepts a final JSONL assistant message with tool requests absent", () => {
  const handler = new StreamingResponseHandler();

  handler.handleUpdate({
    sessionUpdate: "agent_message_completion",
    content: {
      type: "json",
      json: {
        type: "assistant.message",
        data: {
          content: "Final answer"
        }
      }
    }
  });

  assert.equal(handler.getText(), "Final answer");
});

test("StreamingResponseHandler filters tool requests attached to the JSONL envelope", () => {
  const handler = new StreamingResponseHandler();

  handler.handleUpdate({
    sessionUpdate: "agent_message",
    content: {
      type: "json",
      json: {
        type: "assistant.message",
        toolRequests: [{ name: "search" }],
        data: {
          content: "I'll search the workspace.",
          toolRequests: []
        }
      }
    }
  });

  assert.equal(handler.getText(), "");
});

test("StreamingResponseHandler does not duplicate an identical completion snapshot", () => {
  const handler = new StreamingResponseHandler();
  const finalMessage = {
    type: "json" as const,
    json: {
      type: "assistant.message",
      data: {
        content: "Final answer",
        toolRequests: []
      }
    }
  };

  handler.handleUpdate({
    sessionUpdate: "agent_message",
    content: finalMessage
  });
  handler.handleUpdate({
    sessionUpdate: "agent_message_completion",
    content: finalMessage
  });

  assert.equal(handler.getText(), "Final answer");
});
