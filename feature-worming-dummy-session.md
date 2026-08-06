
# Feature Request: Prepared ACP Session Pool for First-Request Latency Reduction

## Summary

Implement a **Prepared ACP Session Pool** to reduce first-message latency by pre-creating and configuring one or more ACP sessions before they are assigned to users.

Instead of creating a new ACP session when the first message arrives, the adapter should claim an already-prepared session, assign it to the conversation, and immediately begin creating a replacement session in the background.

This feature is intended to eliminate the session initialization cost from the user's critical request path while preserving complete session isolation.

---

# Problem

The first message of a new conversation consistently takes longer than subsequent messages.

Current flow:

```
User sends first message
    ↓
session/new
    ↓
session/set_config_option(...)
    ↓
(optional session/resume)
    ↓
session/prompt
```

Most of this work occurs synchronously during the user's request.

After the conversation has an ACP session, subsequent prompts are significantly faster.

---

# Goal

Move ACP session creation and configuration off the critical request path.

The adapter should always maintain one or more fully prepared sessions ready for immediate assignment.

---

# Design

Introduce a new component:

```
PreparedSessionPool
```

Responsibilities:

* Create ACP sessions in advance
* Configure agent/model options
* Maintain a configurable pool size
* Atomically assign prepared sessions
* Automatically replenish the pool
* Rotate stale sessions
* Recover after reconnects

The pool is completely internal to the adapter.

Prepared sessions are **never shared** between conversations.

Once assigned to a conversation they become normal conversation sessions.

---

# Session Lifecycle

## Startup

```
Connect WebSocket
        ↓
initialize
        ↓
Create prepared session
        ↓
Configure session
        ↓
Store in pool
```

The adapter should not block serving requests if pool creation fails.

Pool creation should retry in the background.

---

## First User Message

```
Conversation arrives
        ↓
Claim prepared session
        ↓
Associate session with conversation
        ↓
(session/resume if required)
        ↓
session/prompt
        ↓
Background:
    create replacement session
```

The replacement session should not delay the user's response.

---

## Subsequent Messages

Normal behavior:

```
Lookup conversation session
        ↓
session/prompt
```

No changes.

---

# Pool Behavior

Default configuration:

```
poolSize = 1
```

Future versions may support larger pools.

Each prepared session should include:

* configured agent
* configured model
* working directory
* MCP server configuration

Prepared sessions should contain:

* no conversation history
* no prompts
* no permission approvals
* no pending operations

The adapter must never send synthetic prompts simply to warm a session.

---

# Session Assignment

Assignment must be atomic.

Pseudo-code:

```ts
const prepared = pool.claim();

conversationSessions.set(conversationId, prepared.sessionId);

await websocket.sessionResume(prepared.sessionId);

pool.replenishInBackground();
```

If no prepared session is available:

```
Fallback:

session/new
configure
assign
```

The feature must never block requests waiting for the pool.

---

# Pool Replenishment

After a session is claimed:

```
Create replacement session
        ↓
Configure
        ↓
Publish into pool
```

If creation fails:

* log warning
* retry with exponential backoff
* continue serving requests normally

---

# Session Rotation

Prepared sessions may expire after a configurable age.

Example:

```
ACP_PREPARED_SESSION_MAX_AGE_MS=900000
```

Default:

0 (never expires in warm-pool logic).

If set to a positive value, sessions older than that age are evicted from the warm pool and replenished.

Expired sessions should be replaced proactively.

---

# Reconnection Handling

Whenever the WebSocket reconnects:

```
Discard prepared pool

Reconnect

Initialize ACP

Rebuild prepared pool
```

Previously prepared sessions should be assumed invalid unless explicitly confirmed by the backend.

---

# Configuration

```
ACP_PREPARED_SESSION_ENABLED=true

ACP_PREPARED_SESSION_POOL_SIZE=1

ACP_PREPARED_SESSION_MAX_AGE_MS=0

ACP_PREPARED_SESSION_BACKGROUND_RETRY_MS=10000
```

---

# Metrics

Add instrumentation for:

```
prepared_session_created

prepared_session_claimed

prepared_session_expired

prepared_session_failed

prepared_session_pool_size

prepared_session_creation_ms

prepared_session_age_ms

prepared_session_fallback_count
```

Also record request timing:

```
pool_claim_ms

session_resume_ms

session_prompt_ms

first_response_ms
```

---

# Logging

Log structured events:

```
Prepared session created

Prepared session assigned

Prepared session replenished

Prepared session expired

Prepared session destroyed

Prepared session creation failed

Pool exhausted

Fallback session created
```

---

# Safety Requirements

A prepared session may only be assigned once.

After assignment it becomes permanently owned by that conversation.

Prepared sessions must never:

* be returned to the pool
* be reassigned
* be shared
* contain previous prompts
* contain permission approvals
* contain user state

---

# Acceptance Criteria

* First-message latency decreases measurably compared to creating sessions on demand.
* Existing conversation behavior remains unchanged.
* Background replenishment never blocks user requests.
* Pool exhaustion falls back automatically to the existing session creation flow.
* The feature tolerates WebSocket reconnects and backend restarts.
* The implementation is fully configurable and can be disabled without affecting existing behavior.

---

# Future Enhancements

If the ACP backend later supports immutable session templates or session cloning, the pool implementation should be replaceable behind the same interface without changing the adapter's request flow.
