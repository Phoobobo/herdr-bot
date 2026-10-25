// Source-derived grok session-log fixtures (NOT captured from a live,
// logged-in grok; none was available). Line shape copied from Grok Build
// 1.0.70 sources (xai-grok-shell @ 559751fd):
// - extensions/session_updates.rs tests (updates.jsonl lines):
//   {"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":
//    {"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"first"}}}}
// - extensions/notification.rs TurnCompleted + pager-pty-harness/src/leader.rs:
//   {"sessionUpdate":"turn_completed","prompt_id":"p-1","stop_reason":"end_turn"}
//   on method "_x.ai/session/update".
// - session/storage/mod.rs: user chunks may carry _meta {promptIndex, hostTurn,
//   interjection}; agent_thought_chunk / tool_call are persisted too.

export type Line = Record<string, unknown>;

let ts = 1_790_000_000;

function env(sessionId: string, update: Record<string, unknown>, xai = false): string {
  return JSON.stringify({
    timestamp: ts++,
    method: xai ? "_x.ai/session/update" : "session/update",
    params: { sessionId, update },
  });
}

export const userChunk = (sid: string, text: string, promptIndex = 0) =>
  env(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { promptIndex } });

export const agentChunk = (sid: string, text: string) =>
  env(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

export const thoughtChunk = (sid: string, text: string) =>
  env(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });

export const toolCall = (sid: string, id: string, title: string) =>
  env(sid, { sessionUpdate: "tool_call", toolCallId: id, title, kind: "read", status: "pending" });

export const toolCallDone = (sid: string, id: string) =>
  env(sid, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });

export const turnCompleted = (
  sid: string,
  stop_reason = "end_turn",
  extra: Record<string, unknown> = {},
) =>
  env(
    sid,
    { sessionUpdate: "turn_completed", prompt_id: `p-${ts}`, stop_reason, elapsed_ms: 1234, ...extra },
    true,
  );

/** Split text into n roughly equal chunks (grok merges, but a pending tail can land separately). */
export function chunked(text: string, n = 3): string[] {
  const chars = [...text];
  const size = Math.max(1, Math.ceil(chars.length / n));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out.length ? out : [""];
}

/** One full turn: user prompt, thought, reply chunks, turn_completed. */
export function turnLines(sid: string, prompt: string, reply: string, promptIndex = 0): string[] {
  return [
    userChunk(sid, prompt, promptIndex),
    thoughtChunk(sid, "Planning a reply"),
    ...chunked(reply).map((c) => agentChunk(sid, c)),
    turnCompleted(sid),
  ];
}

// Required write-back payloads: multi-line, fenced code block, long Chinese.
export const MULTILINE_REPLY = "第一行：收到。\nSecond line, with  two spaces.\n\n  - indented bullet\nlast line";
export const CODE_BLOCK_REPLY = [
  "Here is the fix:",
  "",
  "```ts",
  "export function add(a: number, b: number): number {",
  "  return a + b; // keep `a + b`",
  "}",
  "```",
  "",
  "Run `bun test` after.",
].join("\n");
export const LONG_CHINESE_REPLY =
  "好的，我来总结一下今天的进展。首先，我们已经把四个机器人的运行时从 pi 切换到了 Grok Build，" +
  "每个机器人都有自己的工作窗格、私聊窗格和频道窗格，互不干扰。其次，回写不再依赖屏幕抓取，" +
  "而是直接读取 grok 的结构化会话日志，因此多行文本、代码块以及很长的中文段落都能原样保存，" +
  "不会因为终端换行而被截断或拼错。最后，如果模型标识不在可用列表里，启动会明确报错，" +
  "提示你先登录或者换一个模型。还有什么需要我跟进的吗？";
