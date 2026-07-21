import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  buildContinuationMessage,
  buildSummaryPrompt,
} from "../src/index.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

const readFileSyncMock = vi.mocked(readFileSync);

type Handler = (event: any, ctx: any) => any;

const DECISION_TOOL_NAME = "record_supercompact_decision";
const AGENT_TOOL_NAME = "supercompact";
const PROJECT_CWD = "/workspace/test-project";

interface HarnessOptions {
  idle?: boolean;
  hasUI?: boolean;
  allowDecisionTool?: boolean;
  allowAgentTool?: boolean;
  projectTrusted?: boolean;
  globalConfig?: string;
  projectConfig?: string;
}

function missingFile(): Error & { code: string } {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function createHarness(options: HarnessOptions = {}) {
  readFileSyncMock.mockImplementation((path) => {
    const value = String(path);
    if (value === `${PROJECT_CWD}/.pi/pi-supercompact.json`) {
      if (options.projectConfig !== undefined) return options.projectConfig;
      throw missingFile();
    }
    if (value.endsWith("/pi-supercompact.json")) {
      if (options.globalConfig !== undefined) return options.globalConfig;
      throw missingFile();
    }
    throw missingFile();
  });

  const handlers = new Map<string, Handler>();
  let command:
    | { handler: (args: string, ctx: any) => Promise<void> }
    | undefined;
  const tools = new Map<string, any>();
  let activeTools = ["read", "bash"];

  const pi = {
    on: vi.fn((event: string, handler: Handler) =>
      handlers.set(event, handler),
    ),
    registerCommand: vi.fn((_name: string, value: typeof command) => {
      command = value;
    }),
    registerTool: vi.fn((value: any) => {
      tools.set(value.name, value);
      if (!activeTools.includes(value.name)) activeTools.push(value.name);
      if (
        (options.allowDecisionTool === false &&
          value.name === DECISION_TOOL_NAME) ||
        (options.allowAgentTool === false && value.name === AGENT_TOOL_NAME)
      ) {
        activeTools = activeTools.filter((name) => name !== value.name);
      }
    }),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((toolNames: string[]) => {
      activeTools = toolNames.filter(
        (toolName) =>
          !(
            options.allowDecisionTool === false &&
            toolName === DECISION_TOOL_NAME
          ) &&
          !(options.allowAgentTool === false && toolName === AGENT_TOOL_NAME),
      );
    }),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: PROJECT_CWD,
    mode: "tui",
    hasUI: options.hasUI ?? true,
    isProjectTrusted: vi.fn(() => options.projectTrusted ?? true),
    isIdle: vi.fn(() => options.idle ?? true),
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      editor: vi.fn(),
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
    },
    compact: vi.fn(),
    abort: vi.fn(),
  };

  extension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  return {
    pi: pi as any,
    ctx,
    handlers,
    command: () => {
      if (!command) throw new Error("command not registered");
      return command;
    },
    decisionTool: () => {
      const tool = tools.get(DECISION_TOOL_NAME);
      if (!tool) throw new Error("decision tool not registered");
      return tool;
    },
    agentTool: () => {
      const tool = tools.get(AGENT_TOOL_NAME);
      if (!tool) throw new Error("agent tool not registered");
      return tool;
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
  await harness
    .command()
    .handler(extraContext ? `run ${extraContext}` : "run", harness.ctx);
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

async function prepareDecisionAndCompact(
  harness: ReturnType<typeof createHarness>,
  continuation: "continue" | "stop" = "stop",
) {
  const { message } = summaryRequestFrom(harness);
  harness.handlers.get("message_end")?.(customMessage(message), harness.ctx);
  harness.handlers.get("message_end")?.(
    assistantMessage("## State\nAgent-triggered summary.", [
      { id: "decision-1" },
    ]),
    harness.ctx,
  );
  await executeDecision(harness, continuation);
  harness.handlers.get("agent_settled")?.({}, harness.ctx);
}

describe("summary helpers", () => {
  it("builds a canonical Markdown handoff prompt with conservative metadata", () => {
    const prompt = buildSummaryPrompt("stop after compaction");

    expect(prompt).toContain("stop after compaction");
    expect(prompt).toContain(DECISION_TOOL_NAME);
    expect(prompt).toContain("ordinary Markdown with no wrapper");
    expect(prompt).toContain("non-obvious constraints");
    expect(prompt).toContain("source-of-truth or responsibility decisions");
    expect(prompt).toContain("do not infer new ones");
    expect(prompt.indexOf("- Files by work horizon")).toBeLessThan(
      prompt.indexOf("- Next action"),
    );
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
    expect(continuing).toContain(
      "not as permission to broaden scope, move responsibilities, or duplicate an existing source of truth",
    );
    expect(continuing.endsWith("Context")).toBe(true);
    expect(stopping).toContain("wait for the user's next instruction");
    expect(stopping.endsWith("Context")).toBe(true);
  });
});

describe("supercompact workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the agent tool inactive by default", async () => {
    const harness = createHarness();

    expect(harness.activeTools()).toEqual(["read", "bash"]);
    await expect(
      harness
        .agentTool()
        .execute("agent-1", {}, undefined, undefined, harness.ctx),
    ).rejects.toThrow("not authorized");
  });

  it("loads trusted project config over global config", () => {
    const enabled = createHarness({
      globalConfig: JSON.stringify({ agentToolEnabled: false }),
      projectConfig: JSON.stringify({ agentToolEnabled: true }),
    });
    expect(enabled.activeTools()).toContain(AGENT_TOOL_NAME);

    const disabled = createHarness({
      globalConfig: JSON.stringify({ agentToolEnabled: true }),
      projectConfig: JSON.stringify({ agentToolEnabled: false }),
    });
    expect(disabled.activeTools()).not.toContain(AGENT_TOOL_NAME);

    const untrusted = createHarness({
      globalConfig: JSON.stringify({ agentToolEnabled: true }),
      projectConfig: JSON.stringify({ agentToolEnabled: false }),
      projectTrusted: false,
    });
    expect(untrusted.activeTools()).toContain(AGENT_TOOL_NAME);
  });

  it("fails closed on invalid config", () => {
    const harness = createHarness({
      globalConfig: JSON.stringify({ agentToolEnabled: true }),
      projectConfig: JSON.stringify({ agentToolEnabled: "yes" }),
    });

    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid supercompact config"),
      "warning",
    );
  });

  it("opens a menu and editor for an interactive run", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue("Run supercompact now");
    harness.ctx.ui.editor.mockResolvedValue("focus on menu context");

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.select).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.editor).toHaveBeenCalledOnce();
    expect(summaryRequestFrom(harness).message.content).toContain(
      "focus on menu context",
    );
  });

  it("requires explicit syntax when the menu has no UI", async () => {
    const harness = createHarness({ hasUI: false });

    await harness.command().handler("", harness.ctx);
    expect(harness.ctx.ui.select).not.toHaveBeenCalled();
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();

    await harness.command().handler("run headless context", harness.ctx);
    expect(summaryRequestFrom(harness).message.content).toContain(
      "headless context",
    );
  });

  it("authorizes one agent invocation and removes the tool after compaction", async () => {
    const harness = createHarness({ idle: false });

    await harness.command().handler("allow", harness.ctx);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: allowed once",
    );

    const result = await harness
      .agentTool()
      .execute(
        "agent-1",
        { extraContext: "preserve agent context" },
        undefined,
        undefined,
        harness.ctx,
      );
    expect(result.details.authorization).toBe("once");
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).toContain(DECISION_TOOL_NAME);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );

    await expect(
      harness
        .agentTool()
        .execute("agent-2", {}, undefined, undefined, harness.ctx),
    ).rejects.toThrow("already in progress");

    await prepareDecisionAndCompact(harness);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).not.toContain(DECISION_TOOL_NAME);

    harness.ctx.compact.mock.calls[0][0].onComplete({});
    expect(harness.activeTools()).toEqual(["read", "bash"]);
    expect(harness.pi.sendMessage.mock.calls[1][0].details.summary).toContain(
      "Agent-triggered summary",
    );
  });

  it("keeps the enabled agent tool active after workflow success", async () => {
    const harness = createHarness({ idle: false });

    await harness.command().handler("enable", harness.ctx);
    await harness
      .agentTool()
      .execute("agent-1", {}, undefined, undefined, harness.ctx);
    await prepareDecisionAndCompact(harness);
    harness.ctx.compact.mock.calls[0][0].onComplete({});

    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).not.toContain(DECISION_TOOL_NAME);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent enabled",
    );
  });

  it("keeps the enabled agent tool active after workflow failure", async () => {
    const harness = createHarness({ idle: false });

    await harness.command().handler("enable", harness.ctx);
    await harness
      .agentTool()
      .execute("agent-1", {}, undefined, undefined, harness.ctx);
    await prepareDecisionAndCompact(harness);
    harness.ctx.compact.mock.calls[0][0].onError(new Error("provider failed"));

    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).not.toContain(DECISION_TOOL_NAME);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent enabled",
    );
  });

  it("clears an unused one-shot authorization on session reload", async () => {
    const harness = createHarness();

    await harness.command().handler("allow", harness.ctx);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);

    harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);

    expect(harness.activeTools()).toEqual(["read", "bash"]);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );
  });

  it("disables an unused one-shot authorization immediately", async () => {
    const harness = createHarness();

    await harness.command().handler("allow", harness.ctx);
    await harness.command().handler("disable", harness.ctx);

    expect(harness.activeTools()).toEqual(["read", "bash"]);
    await expect(
      harness
        .agentTool()
        .execute("agent-1", {}, undefined, undefined, harness.ctx),
    ).rejects.toThrow("not authorized");
  });

  it("rejects ambiguous legacy command arguments", async () => {
    const harness = createHarness();

    await harness.command().handler("focus on tests", harness.ctx);

    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Usage: /supercompact"),
      "error",
    );
  });

  it("queues steering while busy and echoes extra instructions once", async () => {
    const harness = createHarness({ idle: false });

    await harness.command().handler("run focus on tests", harness.ctx);

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

    await harness.command().handler("run", harness.ctx);

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
    await harness.command().handler("run", harness.ctx);
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
    await harness.command().handler("run", harness.ctx);
    await harness.command().handler("run again", harness.ctx);

    expect(harness.pi.sendMessage).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompact is already in progress.",
      "warning",
    );
  });
});
