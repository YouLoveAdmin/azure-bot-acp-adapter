import WebSocket from "ws";

type BridgePayload = {
  effectiveId: string;
  userMessage: string;
};

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);

    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });

    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForReply(ws: WebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket reply timeout")), timeoutMs);

    ws.once("message", (message) => {
      clearTimeout(timer);
      resolve(message.toString());
    });

    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function sendToBackend(
  websocketUrl: string,
  websocketAuthToken: string,
  payload: BridgePayload,
  timeoutMs: number
): Promise<string> {
  const ws = new WebSocket(websocketUrl, {
    headers: {
      Authorization: `Bearer ${websocketAuthToken}`
    }
  });

  try {
    await waitForOpen(ws, timeoutMs);

    ws.send(
      JSON.stringify({
        type: "session/message",
        sessionId: payload.effectiveId,
        message: payload.userMessage
      })
    );

    const reply = await waitForReply(ws, timeoutMs);
    return reply;
  } finally {
    ws.close();
  }
}
