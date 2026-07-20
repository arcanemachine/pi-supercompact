import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  buildContinuationMessage,
  buildSummaryPrompt,
} from "../src/index.js";

type Handler = (event: any, ctx: any) => any;

const DECISION_TOOL_NAME = "record_supercompact_decision";

function createHarness(
  options: { idle?: boolean; allowDecisionTool?: boolean } = {},
) {
  const handlers = new Map<string, Handler>();
  let command:
    | { handler: (args: string, ctx: any) => Promise<void> }
    | undefined;
  let decisionTool: any;
  let activeTools = ["read", "bash"];

  const pi = {
    on: vi.fn((event: string, handler: Handler) =>
      handlers.set(event, handler),
    ),
    registerCommand: vi.fn((_name: string, value: typeof command) => {
      command = value;
    }),
    registerTool: vi.fn((value: any) => {
      decisionTool = value;
    }),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((toolNames: string[]) => {
      activeTools =
        options.allowDecisionTool === false
          ? toolNames.filter((toolName) => toolName !== DECISION_TOOL_NAME)
          : [...toolNames];
    }),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  extension(pi);

  const ctx = {
    hasUI: true,
    isIdle: vi.fn(() => options.idle ?? true),
    ui: {
      notify: vi.fn(),
      setWorkingMessage: vi.fn(),
    },
    compact: vi.fn(),
    abort: vi.fn(),
  };

  return {
    pi: pi as any,
    ctx,
    handlers,
    command: () => {
      if (!command) throw new Error("command not registered");
      return command;
    },
    decisionTool: () => {
      if (!decisionTool) throw new Error("decision tool not registered");
      return decisionTool;
    },
    activeTools: () => [...activeTools],
  };
}

function summaryRequestFrom(
  harness: ReturnType<typeof createHarness>,
  call = 0,
) {
  const [message, options] = harness.pi.sendMessage.mock.calls[call];
  return { message, options };
}

function customMessage(requestMessage: any) {
  return {
    message: {
      role: "custom",
      customType: requestMessage.customType,
      content: requestMessage.content,
      display: false,
      details: requestMessage.details,
      timestamp: Date.now(),
    },
  };
}

function assistantMessage(
  text: string,
  toolCalls: Array<{
    id: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }> = [],
  stopReason = "stop",
) {
  return {
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...toolCalls.map((call) => ({
          type: "toolCall",
          id: call.id,
          name: call.name ?? DECISION_TOOL_NAME,
          arguments: call.arguments ?? { continuation: "continue" },
        })),
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason,
      timestamp: Date.now(),
    },
  };
}

function toolResultMessage(
  toolCallId: string,
  options: { isError?: boolean; toolName?: string } = {},
) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: options.toolName ?? DECISION_TOOL_NAME,
    content: [{ type: "text", text: options.isError ? "Invalid" : "Recorded" }],
    details: {},
    isError: options.isError ?? false,
    timestamp: Date.now(),
  };
}

async function beginSummary(
  harness: ReturnType<typeof createHarness>,
  extraContext = "",
) {
  await harness.command().handler(extraContext, harness.ctx);
  const { message } = summaryRequestFrom(harness);
  harness.handlers.get("message_end")?.(customMessage(message), harness.ctx);
  return message;
}

async function executeDecision(
  harness: ReturnType<typeof createHarness>,
  continuation: "continue" | "stop",
  toolCallId = "decision-1",
) {
  return harness
    .decisionTool()
    .execute(toolCallId, { continuation }, undefined, undefined, harness.ctx);
}

describe("summary helpers", () => {
  it("builds a canonical Markdown handoff prompt with conservative metadata", () => {
    const prompt = buildSummaryPrompt("stop after compaction");

    expect(prompt).toContain("canonical working-memory handoff");
    expect(prompt).toContain("stop after compaction");
    expect(prompt).toContain("Exact next action");
    expect(prompt).toContain("explicitly non-exhaustive");
    expect(prompt).toContain("Mutable observations");
    expect(prompt).toContain("Do not include commit hashes");
    expect(prompt).toContain("When uncertain, choose stop");
    expect(prompt).toContain("optional improvements");
    expect(prompt).toContain(DECISION_TOOL_NAME);
    expect(prompt).toContain("ordinary Markdown with no wrapper");
    expect(prompt).not.toContain("<supercompact");
  });

  it("builds action-specific continuation and targeted file guidance", () => {
    const continuing = buildContinuationMessage({
      action: "continue",
      summary: "Context",
    });
    const stopping = buildContinuationMessage({
      action: "stop",
      summary: "Context",
    });

    expect(continuing).toContain(
      "Continue the previously authorized incomplete work now",
    );
    expect(continuing).toContain("reread relevant files as needed");
    expect(continuing).toContain("do not reread everything");
    expect(stopping).toContain("wait for the user's next instruction");
  });
});

describe("supercompact workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues steering while busy and echoes extra instructions once", async () => {
    const harness = createHarness({ idle: false });

    await harness.command().handler("focus on tests", harness.ctx);

    const { message, options } = summaryRequestFrom(harness);
    expect(message.customType).toBe("pi-supercompact:summary-request");
    expect(message.content).toContain("focus on tests");
    expect(message.display).toBe(false);
    expect(options).toEqual({ deliverAs: "steer" });
    expect(harness.ctx.ui.notify).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Supercompaction queued; finishing the current tool batch first.\nExtra instructions: focus on tests",
      "info",
    );
    expect(harness.activeTools()).toEqual(["read", "bash", DECISION_TOOL_NAME]);
  });

  it("shows idle extra instructions once and starts the working message", async () => {
    const harness = createHarness();
    const requestMessage = await beginSummary(harness, "preserve this detail");

    expect(harness.ctx.ui.notify).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Creating super-summary.\nExtra instructions: preserve this detail",
      "info",
    );
    expect(harness.ctx.ui.setWorkingMessage).toHaveBeenCalledWith(
      "Creating super-summary…",
    );
    expect(requestMessage.content).toContain("preserve this detail");
  });

  it("fails safely when the internal tool is unavailable", async () => {
    const harness = createHarness({ allowDecisionTool: false });

    await harness.command().handler("", harness.ctx);

    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "internal continuation-decision tool is unavailable",
      ),
      "error",
    );
  });

  it("renders successful internal metadata without visible lines", async () => {
    const harness = createHarness();
    await harness.command().handler("", harness.ctx);
    const tool = harness.decisionTool();

    expect(tool.renderCall({}, {}, {}).render(80)).toEqual([]);
    expect(
      tool.renderResult({}, {}, {}, { isError: false }).render(80),
    ).toEqual([]);
    expect(tool.renderResult({}, {}, {}, { isError: true }).render(80)).toEqual(
      ["Continuation metadata was invalid; asking the agent to correct it."],
    );
  });

  it("records a visible Markdown summary, compacts, and continues", async () => {
    const harness = createHarness();
    await beginSummary(harness);
    const assistant = assistantMessage("## State\nKeep going.", [
      { id: "decision-1" },
    ]);

    const replacement = harness.handlers.get("message_end")?.(
      assistant,
      harness.ctx,
    );
    expect(replacement).toBeUndefined();
    expect(
      harness.handlers.get("tool_call")?.(
        {
          type: "tool_call",
          toolCallId: "decision-1",
          toolName: DECISION_TOOL_NAME,
          input: { continuation: "continue" },
        },
        harness.ctx,
      ),
    ).toBeUndefined();

    const result = await executeDecision(harness, "continue");
    expect(result.terminate).toBe(true);
    expect(harness.activeTools()).toEqual(["read", "bash"]);
    expect(harness.ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Super-summary prepared. After compaction, the agent will continue working.",
      "info",
    );

    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
    harness.ctx.compact.mock.calls[0][0].onComplete({});

    const [finalMessage, finalOptions] = harness.pi.sendMessage.mock.calls[1];
    expect(finalMessage.customType).toBe("pi-supercompact:context");
    expect(finalMessage.display).toBe(false);
    expect(finalMessage.details.summary).toBe("## State\nKeep going.");
    expect(finalMessage.content).toContain("## State\nKeep going.");
    expect(finalOptions).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("uses successful native auto-compaction and waits after stop", async () => {
    const harness = createHarness();
    await beginSummary(harness);
    harness.handlers.get("message_end")?.(
      assistantMessage("## State\nDone.", [{ id: "decision-1" }]),
      harness.ctx,
    );
    await executeDecision(harness, "stop");
    harness.handlers.get("session_compact")?.({}, harness.ctx);
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.ctx.compact).not.toHaveBeenCalled();
    const [finalMessage, finalOptions] = harness.pi.sendMessage.mock.calls[1];
    expect(finalMessage.content).toContain("## State\nDone.");
    expect(finalMessage.display).toBe(false);
    expect(finalOptions).toBeUndefined();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Super-summary prepared. After compaction, the agent will wait for further instructions before proceeding.",
      "info",
    );
  });

  it("requests one metadata-only correction when the tool is omitted", async () => {
    const harness = createHarness();
    await beginSummary(harness);
    harness.handlers.get("message_end")?.(
      assistantMessage("## State\nCaptured."),
      harness.ctx,
    );
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.pi.sendMessage).toHaveBeenCalledTimes(2);
    const correction = summaryRequestFrom(harness, 1);
    expect(correction.message.content).toContain("Do not repeat it");
    expect(correction.message.content).toContain(DECISION_TOOL_NAME);
    expect(correction.options).toEqual({
      triggerTurn: true,
      deliverAs: "steer",
    });

    harness.handlers.get("message_end")?.(
      customMessage(correction.message),
      harness.ctx,
    );
    harness.handlers.get("message_end")?.(
      assistantMessage("", [{ id: "decision-2" }]),
      harness.ctx,
    );
    await executeDecision(harness, "continue", "decision-2");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    harness.ctx.compact.mock.calls[0][0].onComplete({});

    expect(harness.pi.sendMessage.mock.calls[2][0].details.summary).toBe(
      "## State\nCaptured.",
    );
  });

  it("preserves validation errors for correction and succeeds on retry", async () => {
    const harness = createHarness();
    await beginSummary(harness);
    const invalidAssistant = assistantMessage("## State\nRetry metadata.", [
      {
        id: "invalid-1",
        arguments: { continuation: "maybe" },
      },
    ]).message;
    harness.handlers.get("message_end")?.(
      { message: invalidAssistant },
      harness.ctx,
    );
    const invalidResult = toolResultMessage("invalid-1", { isError: true });
    harness.handlers.get("tool_result")?.(invalidResult, harness.ctx);

    expect(
      harness.handlers.get("context")?.(
        { type: "context", messages: [invalidAssistant, invalidResult] },
        harness.ctx,
      ),
    ).toBeUndefined();
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.handlers.get("message_end")?.(
      assistantMessage("", [{ id: "decision-2" }]),
      harness.ctx,
    );
    await executeDecision(harness, "stop", "decision-2");
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("wait for further instructions"),
      "info",
    );
  });

  it("bounds invalid metadata retries and fails without compaction", async () => {
    const harness = createHarness();
    await beginSummary(harness);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      harness.handlers.get("message_end")?.(
        assistantMessage(attempt === 1 ? "## State\nBounded." : "", [
          {
            id: `invalid-${attempt}`,
            arguments: { continuation: "maybe" },
          },
        ]),
        harness.ctx,
      );
      harness.handlers.get("tool_result")?.(
        toolResultMessage(`invalid-${attempt}`, { isError: true }),
        harness.ctx,
      );
    }

    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.activeTools()).toEqual(["read", "bash"]);
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
    expect(harness.pi.sendMessage).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("remained invalid after 3 attempts"),
      "error",
    );
  });

  it("blocks other tools and batches containing additional calls", async () => {
    const harness = createHarness();
    await beginSummary(harness);
    harness.handlers.get("message_end")?.(
      assistantMessage("## State\nNo other tools.", [
        { id: "decision-1" },
        { id: "bash-1", name: "bash", arguments: { command: "pwd" } },
      ]),
      harness.ctx,
    );

    expect(
      harness.handlers.get("tool_call")?.(
        {
          type: "tool_call",
          toolCallId: "decision-1",
          toolName: DECISION_TOOL_NAME,
          input: { continuation: "continue" },
        },
        harness.ctx,
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("exactly once"),
    });
    expect(
      harness.handlers.get("tool_call")?.(
        {
          type: "tool_call",
          toolCallId: "bash-1",
          toolName: "bash",
          input: { command: "pwd" },
        },
        harness.ctx,
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("Tools other than"),
    });
  });

  it("keeps only the newest restored context and filters transcript duplicates", () => {
    const harness = createHarness();
    const oldContext = {
      role: "custom",
      customType: "pi-supercompact:context",
      content: "old hidden",
      display: false,
      details: { version: 2, continuation: "stop", summary: "Old summary" },
      timestamp: 1,
    };
    const newContext = {
      role: "custom",
      customType: "pi-supercompact:context",
      content: "new hidden",
      display: false,
      details: { version: 2, continuation: "continue", summary: "New summary" },
      timestamp: 2,
    };
    const oldVisible = assistantMessage("Old summary").message;
    const newVisible = assistantMessage("New summary", [
      { id: "decision-old" },
    ]).message;
    const decisionResult = toolResultMessage("decision-old");
    const unrelated = assistantMessage("Keep this message").message;

    const filtered = harness.handlers.get("context")?.(
      {
        type: "context",
        messages: [
          oldContext,
          oldVisible,
          newVisible,
          decisionResult,
          unrelated,
          newContext,
        ],
      },
      harness.ctx,
    );

    expect(filtered.messages).toEqual([unrelated, newContext]);
  });

  it("cleans up UI and tool state on compaction failure", async () => {
    const harness = createHarness();
    await beginSummary(harness);
    harness.handlers.get("message_end")?.(
      assistantMessage("Summary", [{ id: "decision-1" }]),
      harness.ctx,
    );
    await executeDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    harness.ctx.compact.mock.calls[0][0].onError(new Error("provider failed"));

    expect(harness.activeTools()).toEqual(["read", "bash"]);
    expect(harness.ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompact failed: provider failed",
      "error",
    );
    expect(harness.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("rejects a second request while one is active", async () => {
    const harness = createHarness();
    await harness.command().handler("", harness.ctx);
    await harness.command().handler("again", harness.ctx);

    expect(harness.pi.sendMessage).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompact is already in progress.",
      "warning",
    );
  });
});
