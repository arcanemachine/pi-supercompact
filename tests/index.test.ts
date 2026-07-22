import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  buildContinuationMessage,
  buildPreparationPrompt,
  buildSummaryPrompt,
} from "../src/index.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

const readFileSyncMock = vi.mocked(readFileSync);

type Handler = (event: any, ctx: any) => any;

const PREPARATION_REQUEST_TYPE = "pi-supercompact:preparation-request";
const SUMMARY_REQUEST_TYPE = "pi-supercompact:summary-request";
const CONTEXT_MESSAGE_TYPE = "pi-supercompact:context";
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
  confirmed?: boolean;
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
  let command: any;
  const tools = new Map<string, any>();
  let activeTools = ["read", "bash"];
  const sendMessage = vi.fn();

  const pi = {
    on: vi.fn((event: string, handler: Handler) =>
      handlers.set(event, handler),
    ),
    registerCommand: vi.fn((_name: string, value: any) => {
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
    sendMessage,
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
      confirm: vi.fn().mockResolvedValue(options.confirmed ?? true),
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
    command: () => command,
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
    messages: (customType: string) =>
      sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.customType === customType),
    messageCalls: (customType: string) =>
      sendMessage.mock.calls.filter(
        ([message]) => message.customType === customType,
      ),
  };
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

function publicParams(
  overrides: Partial<{
    continuation: "continue" | "stop";
    nextAction: string;
    extraContext: string;
  }> = {},
) {
  return {
    continuation: "continue" as const,
    nextAction: "Continue the authorized implementation.",
    ...overrides,
  };
}

async function beginPreparation(
  harness: ReturnType<typeof createHarness>,
  extraContext = "",
) {
  await harness
    .command()
    .handler(extraContext ? `run ${extraContext}` : "run", harness.ctx);
  const message = harness.messages(PREPARATION_REQUEST_TYPE).at(-1);
  if (!message) throw new Error("preparation request not sent");
  return message;
}

async function confirmPreparation(
  harness: ReturnType<typeof createHarness>,
  overrides: Parameters<typeof publicParams>[0] = {},
) {
  const result = await harness
    .agentTool()
    .execute(
      "agent-1",
      publicParams(overrides),
      undefined,
      undefined,
      harness.ctx,
    );
  return result;
}

async function beginPreparedSummary(
  harness: ReturnType<typeof createHarness>,
  options: {
    runContext?: string;
    params?: Parameters<typeof publicParams>[0];
  } = {},
) {
  await beginPreparation(harness, options.runContext);
  await confirmPreparation(harness, options.params);
  const message = harness.messages(SUMMARY_REQUEST_TYPE).at(-1);
  if (!message) throw new Error("summary request not sent");
  harness.handlers.get("message_end")?.(customMessage(message), harness.ctx);
  return message;
}

async function beginForceSummary(
  harness: ReturnType<typeof createHarness>,
  extraContext = "",
) {
  await harness
    .command()
    .handler(extraContext ? `force ${extraContext}` : "force", harness.ctx);
  const message = harness.messages(SUMMARY_REQUEST_TYPE).at(-1);
  if (!message) throw new Error("summary request not sent");
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

async function recordSummaryDecision(
  harness: ReturnType<typeof createHarness>,
  continuation: "continue" | "stop" = "stop",
  options: { text?: string; toolCallId?: string } = {},
) {
  const toolCallId = options.toolCallId ?? "decision-1";
  harness.handlers.get("message_end")?.(
    assistantMessage(options.text ?? "## State\nCanonical handoff.", [
      { id: toolCallId, arguments: { continuation } },
    ]),
    harness.ctx,
  );
  return executeDecision(harness, continuation, toolCallId);
}

async function compactSuccessfully(
  harness: ReturnType<typeof createHarness>,
  continuation: "continue" | "stop" = "stop",
) {
  await recordSummaryDecision(harness, continuation);
  harness.handlers.get("agent_settled")?.({}, harness.ctx);
  harness.ctx.compact.mock.calls.at(-1)?.[0].onComplete({});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.clearAllMocks());

describe("commands and menu", () => {
  it("1. bare command opens the new menu", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue(undefined);

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.select).toHaveBeenCalledWith("Supercompact", [
      "Run pre-compaction wrap",
      "Force supercompaction now",
      "Allow agent supercompaction requests for this session",
      "Forbid agent supercompaction requests for this session",
      "Cancel",
    ]);
  });

  it("2. menu run opens the editor and starts preparation only", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue("Run pre-compaction wrap");
    harness.ctx.ui.editor.mockResolvedValue("focus on context");

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.editor).toHaveBeenCalledOnce();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
  });

  it("3. menu force opens the editor and starts summary immediately", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue("Force supercompaction now");
    harness.ctx.ui.editor.mockResolvedValue("force context");

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.editor).toHaveBeenCalledOnce();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "force context",
    );
  });

  it("4. explicit run accepts multiline extra context", async () => {
    const harness = createHarness();
    await harness.command().handler("run first line\nsecond line", harness.ctx);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)[0].content).toContain(
      "first line\nsecond line",
    );
  });

  it("5. explicit force accepts multiline extra context", async () => {
    const harness = createHarness();
    await harness
      .command()
      .handler("force first line\nsecond line", harness.ctx);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "first line\nsecond line",
    );
  });

  it("6. completion exposes only run, force, allow, and forbid", () => {
    const harness = createHarness();
    expect(harness.command().getArgumentCompletions("")).toEqual(
      ["run", "force", "allow", "forbid"].map((value) => ({
        value,
        label: value,
      })),
    );
  });

  it("7. removed, malformed, and legacy commands report the new usage", async () => {
    const harness = createHarness();
    for (const command of [
      "enable",
      "disable",
      "allow extra",
      "forbid extra",
      "legacy bare context",
    ]) {
      await harness.command().handler(command, harness.ctx);
    }
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Usage: /supercompact [run [extra context] | force [extra context] | allow | forbid]",
      "error",
    );
  });

  it("8. menu and run fail safely without UI while force remains available", async () => {
    const harness = createHarness({ hasUI: false });
    await harness.command().handler("", harness.ctx);
    await harness.command().handler("run", harness.ctx);
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();

    await harness.command().handler("force headless", harness.ctx);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });
});

describe("configuration and live-session policy", () => {
  it("9. missing config defaults to forbidden", async () => {
    const harness = createHarness();
    expect(harness.activeTools()).toEqual(["read", "bash"]);
    await expect(
      harness
        .agentTool()
        .execute("agent-1", publicParams(), undefined, undefined, harness.ctx),
    ).rejects.toThrow("not authorized");
  });

  it("10. global true and false are respected", () => {
    expect(
      createHarness({
        globalConfig: '{"agentToolEnabled":true}',
      }).activeTools(),
    ).toContain(AGENT_TOOL_NAME);
    expect(
      createHarness({
        globalConfig: '{"agentToolEnabled":false}',
      }).activeTools(),
    ).not.toContain(AGENT_TOOL_NAME);
  });

  it("11. trusted project config overrides global config", () => {
    const enabled = createHarness({
      globalConfig: '{"agentToolEnabled":false}',
      projectConfig: '{"agentToolEnabled":true}',
    });
    const disabled = createHarness({
      globalConfig: '{"agentToolEnabled":true}',
      projectConfig: '{"agentToolEnabled":false}',
    });
    expect(enabled.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(disabled.activeTools()).not.toContain(AGENT_TOOL_NAME);
  });

  it("12. untrusted project config is ignored", () => {
    const harness = createHarness({
      globalConfig: '{"agentToolEnabled":true}',
      projectConfig: '{"agentToolEnabled":false}',
      projectTrusted: false,
    });
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
  });

  it("13. invalid config fails closed", () => {
    const harness = createHarness({
      globalConfig: '{"agentToolEnabled":true}',
      projectConfig: '{"agentToolEnabled":"yes"}',
    });
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid supercompact config"),
      "warning",
    );
  });

  it("14. allow overrides configured false only in memory", async () => {
    const harness = createHarness({
      globalConfig: '{"agentToolEnabled":false}',
    });
    const reads = readFileSyncMock.mock.calls.length;
    await harness.command().handler("allow", harness.ctx);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(readFileSyncMock.mock.calls).toHaveLength(reads);
  });

  it("15. forbid overrides configured true only in memory", async () => {
    const harness = createHarness({
      globalConfig: '{"agentToolEnabled":true}',
    });
    const reads = readFileSyncMock.mock.calls.length;
    await harness.command().handler("forbid", harness.ctx);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    expect(readFileSyncMock.mock.calls).toHaveLength(reads);
  });

  it("16. session initialization discards overrides and reapplies config", async () => {
    const harness = createHarness({
      globalConfig: '{"agentToolEnabled":true}',
    });
    await harness.command().handler("forbid", harness.ctx);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
  });

  it("17. repeated allow and forbid are idempotent without duplicate tools", async () => {
    const harness = createHarness();
    await harness.command().handler("allow", harness.ctx);
    await harness.command().handler("allow", harness.ctx);
    expect(
      harness.activeTools().filter((name) => name === AGENT_TOOL_NAME),
    ).toHaveLength(1);
    await harness.command().handler("forbid", harness.ctx);
    await harness.command().handler("forbid", harness.ctx);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
  });
});

describe("preparation", () => {
  it("18. run creates one grant and sends focused idle steering", async () => {
    const harness = createHarness();
    const message = await beginPreparation(harness);
    expect(message.content).toContain("focused pre-compaction wrap");
    expect(message.content).toContain("Freshen the active context");
    expect(message.content).toContain("Wrap the active boundary");
    expect(harness.messageCalls(PREPARATION_REQUEST_TYPE)[0][1]).toEqual({
      triggerTurn: true,
      deliverAs: "steer",
    });
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: preparing",
    );
  });

  it("19. run while busy queues steering without a redundant turn", async () => {
    const harness = createHarness({ idle: false });
    await beginPreparation(harness);
    expect(harness.messageCalls(PREPARATION_REQUEST_TYPE)[0][1]).toEqual({
      deliverAs: "steer",
    });
  });

  it("20. run extra context appears once in the preparation prompt", async () => {
    const prompt = buildPreparationPrompt("unique-context-marker");
    expect(prompt.match(/unique-context-marker/g)).toHaveLength(1);
    const harness = createHarness();
    const message = await beginPreparation(harness, "unique-context-marker");
    expect(message.content.match(/unique-context-marker/g)).toHaveLength(1);
  });

  it("21. a second run is rejected while preparation is pending", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    await harness.command().handler("run replacement", harness.ctx);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("already active"),
      "warning",
    );
  });

  it("22. preparation persists while the agent asks a question and waits", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    harness.handlers.get("message_end")?.(
      assistantMessage("I need an answer first."),
      harness.ctx,
    );
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    await confirmPreparation(harness);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("23. forbid cancels an unused preparation grant", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    await harness.command().handler("forbid", harness.ctx);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Pending pre-compaction preparation was canceled.",
      "info",
    );
  });

  it("24. session lifecycle clears preparation and confirmation state", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const pending = confirmPreparation(harness);
    harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);
    confirmation.resolve(true);
    expect((await pending).details.status).toBe("revoked");
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Pending pre-compaction preparation was canceled.",
      "info",
    );

    const shutdown = createHarness();
    await beginPreparation(shutdown);
    shutdown.handlers.get("session_shutdown")?.({}, shutdown.ctx);
    expect(shutdown.activeTools()).not.toContain(AGENT_TOOL_NAME);
    expect(shutdown.ctx.ui.notify).toHaveBeenCalledWith(
      "Pending pre-compaction preparation was canceled.",
      "info",
    );
  });

  it("25. stale preparation controls are removed without substantive messages", async () => {
    const harness = createHarness();
    const active = await beginPreparation(harness);
    const activeContext = customMessage(active).message;
    const stale = {
      ...activeContext,
      details: { preparationId: "stale" },
    };
    const substantive = assistantMessage(
      "Keep completed preparation work",
    ).message;
    const filtered = harness.handlers.get("context")?.(
      {
        type: "context",
        messages: [stale, substantive, activeContext],
      },
      harness.ctx,
    );
    expect(filtered.messages).toEqual([substantive, activeContext]);
  });
});

describe("final confirmation", () => {
  it("26. agent calls are rejected while forbidden without a grant", async () => {
    const harness = createHarness();
    await expect(confirmPreparation(harness)).rejects.toThrow("not authorized");
  });

  it("27. confirmation shows continuation, next action, and contexts", async () => {
    const harness = createHarness();
    await beginPreparation(harness, "run detail");
    await confirmPreparation(harness, {
      continuation: "stop",
      nextAction: "Wait for the user.",
      extraContext: "summary detail",
    });
    expect(harness.ctx.ui.confirm).toHaveBeenCalledWith(
      "Confirm agent-requested supercompaction",
      expect.stringMatching(
        /stop and wait[\s\S]*Wait for the user[\s\S]*run detail[\s\S]*summary detail[\s\S]*native compaction/i,
      ),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("28. confirmation acceptance starts exactly one summary", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("29. confirmation decline starts no summary or compaction", async () => {
    const harness = createHarness({ confirmed: false });
    await beginPreparation(harness);
    const result = await confirmPreparation(harness);
    expect(result.details.status).toBe("declined");
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
  });

  it("30. declining a prepared one-shot clears it and removes the tool", async () => {
    const harness = createHarness({ confirmed: false });
    await beginPreparation(harness);
    await confirmPreparation(harness);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
  });

  it("31. decline under session allow retains policy and directs waiting", async () => {
    const harness = createHarness({ confirmed: false });
    await harness.command().handler("allow", harness.ctx);
    await beginPreparation(harness);
    const result = await confirmPreparation(harness);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(result.content[0].text).toContain("Do not retry automatically");
  });

  it("32. confirmation fails closed without UI", async () => {
    const harness = createHarness({
      hasUI: false,
      globalConfig: '{"agentToolEnabled":true}',
    });
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "requires confirmation",
    );
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
  });

  it("33. concurrent calls cannot open multiple dialogs or workflows", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const first = confirmPreparation(harness);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "confirmation is already in progress",
    );
    expect(harness.ctx.ui.confirm).toHaveBeenCalledOnce();
    confirmation.resolve(false);
    await first;
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
  });

  it("34. a tool call during summary or compaction is rejected", async () => {
    const harness = createHarness();
    await beginPreparedSummary(harness);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "already in progress",
    );
  });

  it("35. user-confirmed stop rejects and corrects internal continue", async () => {
    const harness = createHarness();
    await beginPreparedSummary(harness, {
      params: { continuation: "stop", nextAction: "Wait for the user." },
    });
    harness.handlers.get("message_end")?.(
      assistantMessage("## State\nStop is confirmed.", [
        { id: "decision-1", arguments: { continuation: "continue" } },
      ]),
      harness.ctx,
    );
    await expect(executeDecision(harness, "continue")).rejects.toThrow(
      "hard constraint",
    );
    harness.handlers.get("message_end")?.(
      assistantMessage("", [
        { id: "decision-2", arguments: { continuation: "stop" } },
      ]),
      harness.ctx,
    );
    await expect(
      executeDecision(harness, "stop", "decision-2"),
    ).resolves.toMatchObject({
      terminate: true,
    });
  });

  it("36. user-confirmed continue may conservatively downgrade to stop", async () => {
    const harness = createHarness();
    const request = await beginPreparedSummary(harness);
    expect(request.content).toContain(
      "confirmed continue authorizes continuation but does not force it",
    );
    await expect(recordSummaryDecision(harness, "stop")).resolves.toMatchObject(
      {
        details: { continuation: "stop" },
      },
    );
  });
});

describe("force path", () => {
  it("37. force starts summary without preparation or confirmation", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("38. force remains usable while agent requests are forbidden", async () => {
    const harness = createHarness();
    await harness.command().handler("forbid", harness.ctx);
    await harness.command().handler("force", harness.ctx);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("39. force rejects during confirmation and another workflow", async () => {
    const confirmationHarness = createHarness();
    await beginPreparation(confirmationHarness);
    const confirmation = deferred<boolean>();
    confirmationHarness.ctx.ui.confirm.mockReturnValueOnce(
      confirmation.promise,
    );
    const pending = confirmPreparation(confirmationHarness);
    await confirmationHarness
      .command()
      .handler("force", confirmationHarness.ctx);
    expect(confirmationHarness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    confirmation.resolve(false);
    await pending;

    const active = createHarness();
    await active.command().handler("force", active.ctx);
    await active.command().handler("force", active.ctx);
    expect(active.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("40. force retains busy steering and extra-context behavior", async () => {
    const harness = createHarness({ idle: false });
    await harness.command().handler("force preserve this", harness.ctx);
    const [, options] = harness.messageCalls(SUMMARY_REQUEST_TYPE)[0];
    expect(options).toEqual({ deliverAs: "steer" });
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "preserve this",
    );
  });
});

describe("workflow and caching-sensitive state", () => {
  it("41. consumed preparation remains active through summary validation", async () => {
    const harness = createHarness();
    await beginPreparedSummary(harness);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    await recordSummaryDecision(harness, "stop");
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).not.toContain(DECISION_TOOL_NAME);
  });

  it("42. consumed preparation is removed after successful compaction when forbidden", async () => {
    const harness = createHarness();
    await beginPreparedSummary(harness);
    await compactSuccessfully(harness);
    expect(harness.activeTools()).toEqual(["read", "bash"]);
  });

  it("43. consumed preparation is removed after workflow failure when forbidden", async () => {
    const harness = createHarness();
    await beginPreparedSummary(harness);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    harness.ctx.compact.mock.calls[0][0].onError(new Error("provider failed"));
    expect(harness.activeTools()).toEqual(["read", "bash"]);
  });

  it("44. session allow remains active after workflow success and failure", async () => {
    const success = createHarness();
    await success.command().handler("allow", success.ctx);
    await beginPreparedSummary(success);
    await compactSuccessfully(success);
    expect(success.activeTools()).toContain(AGENT_TOOL_NAME);

    const failure = createHarness();
    await failure.command().handler("allow", failure.ctx);
    await beginPreparedSummary(failure);
    await recordSummaryDecision(failure, "stop");
    failure.handlers.get("agent_settled")?.({}, failure.ctx);
    failure.ctx.compact.mock.calls[0][0].onError(new Error("failed"));
    expect(failure.activeTools()).toContain(AGENT_TOOL_NAME);
  });

  it("45. forbid during preparation removes access immediately", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    await harness.command().handler("forbid", harness.ctx);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    await expect(confirmPreparation(harness)).rejects.toThrow("not authorized");
  });

  it("46. forbid during active summary revokes future access without corruption", async () => {
    const harness = createHarness();
    await beginPreparedSummary(harness);
    await harness.command().handler("forbid", harness.ctx);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).toContain(DECISION_TOOL_NAME);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
  });

  it("47. internal decision cleanup remains independent of public policy", async () => {
    const harness = createHarness();
    await harness.command().handler("allow", harness.ctx);
    await confirmPreparation(harness);
    const summary = harness.messages(SUMMARY_REQUEST_TYPE)[0];
    harness.handlers.get("message_end")?.(customMessage(summary), harness.ctx);
    expect(harness.activeTools()).toContain(DECISION_TOOL_NAME);
    await recordSummaryDecision(harness, "stop");
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).not.toContain(DECISION_TOOL_NAME);
  });

  it("48. continuation, auto-compaction, retries, filtering, and failure cleanup regressions pass", async () => {
    const automatic = createHarness();
    await beginForceSummary(automatic);
    harnessSummary(automatic, "## State\nDone.", "decision-auto");
    await executeDecision(automatic, "stop", "decision-auto");
    automatic.handlers.get("session_compact")?.({}, automatic.ctx);
    automatic.handlers.get("agent_settled")?.({}, automatic.ctx);
    expect(automatic.ctx.compact).not.toHaveBeenCalled();
    expect(automatic.messages(CONTEXT_MESSAGE_TYPE)).toHaveLength(1);

    const correction = createHarness();
    await beginForceSummary(correction);
    correction.handlers.get("message_end")?.(
      assistantMessage("## State\nCaptured."),
      correction.ctx,
    );
    correction.handlers.get("agent_settled")?.({}, correction.ctx);
    expect(correction.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(2);

    const filtering = createHarness();
    const oldContext = restoredContext("Old summary", "stop", 1);
    const newContext = restoredContext("New summary", "continue", 2);
    const duplicate = assistantMessage("Old summary").message;
    const unrelated = assistantMessage("Keep this message").message;
    const filtered = filtering.handlers.get("context")?.(
      {
        type: "context",
        messages: [oldContext, duplicate, unrelated, newContext],
      },
      filtering.ctx,
    );
    expect(filtered.messages).toEqual([unrelated, newContext]);

    const failure = createHarness();
    await beginForceSummary(failure);
    await recordSummaryDecision(failure, "stop");
    failure.handlers.get("agent_settled")?.({}, failure.ctx);
    failure.ctx.compact.mock.calls[0][0].onError(new Error("provider failed"));
    expect(failure.activeTools()).toEqual(["read", "bash"]);
    expect(failure.ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
  });
});

function harnessSummary(
  harness: ReturnType<typeof createHarness>,
  text: string,
  toolCallId: string,
) {
  harness.handlers.get("message_end")?.(
    assistantMessage(text, [
      { id: toolCallId, arguments: { continuation: "stop" } },
    ]),
    harness.ctx,
  );
}

function restoredContext(
  summary: string,
  continuation: "continue" | "stop",
  timestamp: number,
) {
  return {
    role: "custom",
    customType: CONTEXT_MESSAGE_TYPE,
    content: buildContinuationMessage({ action: continuation, summary }),
    display: false,
    details: { version: 3, continuation, summary },
    timestamp,
  };
}

describe("preserved workflow regressions", () => {
  it("cleans up synchronous preparation and summary queue failures", async () => {
    const preparation = createHarness();
    preparation.pi.sendMessage.mockImplementationOnce(() => {
      throw new Error("queue failed");
    });
    await preparation.command().handler("run", preparation.ctx);
    expect(preparation.activeTools()).toEqual(["read", "bash"]);
    expect(preparation.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompact preparation failed: queue failed",
      "error",
    );

    const summary = createHarness();
    await beginPreparation(summary);
    summary.pi.sendMessage.mockImplementationOnce(() => {
      throw new Error("summary queue failed");
    });
    await expect(confirmPreparation(summary)).rejects.toThrow(
      "summary queue failed",
    );
    expect(summary.activeTools()).toEqual(["read", "bash"]);
  });

  it("cleans up a synchronous native compaction failure", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    await recordSummaryDecision(harness, "stop");
    harness.ctx.compact.mockImplementationOnce(() => {
      throw new Error("compact threw");
    });
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.activeTools()).toEqual(["read", "bash"]);
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompact failed: compact threw",
      "error",
    );
  });

  it("fails safely when the internal decision tool is unavailable", async () => {
    const harness = createHarness({ allowDecisionTool: false });
    await beginPreparation(harness);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "internal continuation-decision tool is unavailable",
    );
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.activeTools()).toEqual(["read", "bash"]);
  });

  it("renders successful internal metadata without visible lines", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);
    const tool = harness.decisionTool();
    expect(tool.renderCall({}, {}, {}).render(80)).toEqual([]);
    expect(
      tool.renderResult({}, {}, {}, { isError: false }).render(80),
    ).toEqual([]);
    expect(tool.renderResult({}, {}, {}, { isError: true }).render(80)).toEqual(
      ["Continuation metadata was invalid; asking the agent to correct it."],
    );
  });

  it("restores the exact visible summary and continues after compaction", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    await recordSummaryDecision(harness, "continue", {
      text: "## State\nKeep going.",
    });
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    harness.ctx.compact.mock.calls[0][0].onComplete({});
    const [message, options] = harness.messageCalls(CONTEXT_MESSAGE_TYPE)[0];
    expect(message.details.summary).toBe("## State\nKeep going.");
    expect(message.content).toContain("## State\nKeep going.");
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("preserves decision validation errors for correction", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    const invalid = assistantMessage("## State\nRetry metadata.", [
      { id: "invalid-1", arguments: { continuation: "maybe" } },
    ]).message;
    harness.handlers.get("message_end")?.({ message: invalid }, harness.ctx);
    harness.handlers.get("tool_result")?.(
      toolResultMessage("invalid-1", { isError: true }),
      harness.ctx,
    );
    expect(harness.ctx.abort).not.toHaveBeenCalled();
    harness.handlers.get("message_end")?.(
      assistantMessage("", [
        { id: "decision-2", arguments: { continuation: "stop" } },
      ]),
      harness.ctx,
    );
    await expect(
      executeDecision(harness, "stop", "decision-2"),
    ).resolves.toMatchObject({ terminate: true });
  });

  it("bounds invalid metadata retries and stops before compaction", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
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
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
    expect(harness.activeTools()).toEqual(["read", "bash"]);
  });

  it("blocks other tools and mixed decision batches during summary", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
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
          toolCallId: "decision-1",
          toolName: DECISION_TOOL_NAME,
          input: { continuation: "continue" },
        },
        harness.ctx,
      ),
    ).toEqual({ block: true, reason: expect.stringContaining("exactly once") });
    expect(
      harness.handlers.get("tool_call")?.(
        { toolCallId: "bash-1", toolName: "bash", input: {} },
        harness.ctx,
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("Tools other than"),
    });
  });

  it("filters completed decision artifacts without unrelated messages", () => {
    const harness = createHarness();
    const decision = assistantMessage("", [{ id: "decision-old" }]).message;
    const result = toolResultMessage("decision-old");
    const unrelated = assistantMessage("Keep this message").message;
    const filtered = harness.handlers.get("context")?.(
      { type: "context", messages: [decision, result, unrelated] },
      harness.ctx,
    );
    expect(filtered.messages).toEqual([unrelated]);
  });

  it("cancels confirmation errors and clears one-shot authorization", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    harness.ctx.ui.confirm.mockRejectedValueOnce(new Error("dialog closed"));
    const result = await confirmPreparation(harness);
    expect(result.details.status).toBe("canceled");
    expect(result.content[0].text).toContain("Do not retry automatically");
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
  });

  it("forbid revokes authorization while confirmation is open", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const pending = confirmPreparation(harness);
    await harness.command().handler("forbid", harness.ctx);
    confirmation.resolve(true);
    expect((await pending).details.status).toBe("revoked");
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.activeTools()).not.toContain(AGENT_TOOL_NAME);
  });

  it("rejects an empty exact next action", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    await expect(
      confirmPreparation(harness, { nextAction: "   " }),
    ).rejects.toThrow("nextAction must not be empty");
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
  });
});

describe("summary helper contracts", () => {
  it("preserves preparation intent and exact continuation guidance", () => {
    const prompt = buildSummaryPrompt("", {
      expectedContinuation: "continue",
      nextAction: "Implement the next stage.",
      runExtraContext: "preserve constraints",
      agentExtraContext: "include verification",
    });
    expect(prompt).toContain("Expected continuation: continue");
    expect(prompt).toContain("Exact next action: Implement the next stage.");
    expect(prompt).toContain("preserve constraints");
    expect(prompt).toContain("include verification");
    expect(prompt).toContain(DECISION_TOOL_NAME);
    expect(prompt).toContain("ordinary Markdown with no wrapper");

    const restored = buildContinuationMessage({
      action: "stop",
      summary: "Canonical summary",
      preparation: {
        expectedContinuation: "continue",
        nextAction: "Implement the next stage.",
      },
    });
    expect(restored).toContain("User-confirmed expectation: continue");
    expect(restored).toContain("Validated continuation: stop");
    expect(restored).toContain("conservatively downgraded to stop");
  });
});
