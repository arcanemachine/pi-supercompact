import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  buildConfirmationText,
  buildContinuationMessage,
  buildDecisionPrompt,
  buildPreparationPrompt,
  buildSummaryPrompt,
  previewConfirmationValue,
} from "../src/index.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

const readFileSyncMock = vi.mocked(readFileSync);

type Handler = (event: any, ctx: any) => any;

const PREPARATION_REQUEST_TYPE = "pi-supercompact:preparation-request";
const DECISION_REQUEST_TYPE = "pi-supercompact:decision-request";
const SUMMARY_REQUEST_TYPE = "pi-supercompact:summary-request";
const CONTEXT_MESSAGE_TYPE = "pi-supercompact:context";
const CONTINUATION_OUTCOME_ENTRY_TYPE = "pi-supercompact:continuation-outcome";
const SESSION_PERMISSION_ENTRY_TYPE = "pi-supercompact:session-permission";
const SESSION_AUTOMATIC_ENTRY_TYPE = "pi-supercompact:session-automatic";
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
  flags?: Record<string, boolean>;
  contextUsage?:
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
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
  const commands = new Map<string, any>();
  const flags = new Map<string, boolean>(Object.entries(options.flags ?? {}));
  let contextUsage = options.contextUsage;
  let entryRenderer: any;
  const tools = new Map<string, any>();
  const sessionEntries: any[] = [];
  let activeTools = ["read", "bash"];
  const sendMessage = vi.fn();
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    sessionEntries.push({ type: "custom", customType, data });
  });

  const pi = {
    on: vi.fn((event: string, handler: Handler) =>
      handlers.set(event, handler),
    ),
    registerCommand: vi.fn((name: string, value: any) => {
      commands.set(name, value);
    }),
    registerFlag: vi.fn(),
    getFlag: vi.fn((name: string) => flags.get(name)),
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
    registerEntryRenderer: vi.fn((_customType: string, renderer: any) => {
      entryRenderer = renderer;
    }),
    appendEntry,
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
    sessionManager: {
      getBranch: vi.fn(() => [...sessionEntries]),
      getEntries: vi.fn(() => [...sessionEntries]),
    },
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
    getContextUsage: vi.fn(() => contextUsage),
  };

  extension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  return {
    pi: pi as any,
    ctx,
    handlers,
    command: () => commands.get("supercompact"),
    setContextUsage: (
      usage:
        | {
            tokens: number | null;
            contextWindow: number;
            percent: number | null;
          }
        | undefined,
    ) => {
      contextUsage = usage;
    },
    triggerTurnEnd: () => handlers.get("turn_end")?.({}, ctx),
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
    excludeTool: (toolName: string) => {
      activeTools = activeTools.filter((name) => name !== toolName);
    },
    registeredTools: () => [...tools.values()],
    entryRenderer: () => entryRenderer,
    flags: () => flags,
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

async function executeDecision(
  harness: ReturnType<typeof createHarness>,
  continuation: "continue" | "stop",
  toolCallId = "decision-1",
) {
  return harness
    .decisionTool()
    .execute(toolCallId, { continuation }, undefined, undefined, harness.ctx);
}

async function beginDecision(harness: ReturnType<typeof createHarness>) {
  const message = harness.messages(DECISION_REQUEST_TYPE).at(-1);
  if (!message) throw new Error("decision request not sent");
  harness.handlers.get("message_end")?.(customMessage(message), harness.ctx);
  return message;
}

async function recordDecision(
  harness: ReturnType<typeof createHarness>,
  continuation: "continue" | "stop",
  toolCallId = "decision-1",
) {
  harness.handlers.get("message_end")?.(
    assistantMessage("", [{ id: toolCallId, arguments: { continuation } }]),
    harness.ctx,
  );
  const result = await executeDecision(harness, continuation, toolCallId);
  harness.handlers.get("agent_settled")?.({}, harness.ctx);
  const summary = harness.messages(SUMMARY_REQUEST_TYPE).at(-1);
  if (!summary) throw new Error("summary request not sent");
  harness.handlers.get("message_end")?.(customMessage(summary), harness.ctx);
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
  continuation: "continue" | "stop" = "stop",
) {
  await harness
    .command()
    .handler(extraContext ? `force ${extraContext}` : "force", harness.ctx);
  await beginDecision(harness);
  await recordDecision(harness, continuation);
  const message = harness.messages(SUMMARY_REQUEST_TYPE).at(-1);
  if (!message) throw new Error("summary request not sent");
  return message;
}

async function recordSummaryDecision(
  harness: ReturnType<typeof createHarness>,
  _continuation: "continue" | "stop" = "stop",
  options: { text?: string; toolCallId?: string } = {},
) {
  harness.handlers.get("message_end")?.(
    assistantMessage(options.text ?? "## State\nCanonical handoff."),
    harness.ctx,
  );
}

async function compactSuccessfully(
  harness: ReturnType<typeof createHarness>,
  continuation: "continue" | "stop" = "stop",
) {
  await recordSummaryDecision(harness, continuation);
  harness.handlers.get("agent_settled")?.({}, harness.ctx);
  harness.ctx.compact.mock.calls.at(-1)?.[0].onComplete({});
}

async function finishQueuedSupercompact(
  harness: ReturnType<typeof createHarness>,
) {
  if (harness.messages(DECISION_REQUEST_TYPE).length > 0) {
    await beginDecision(harness);
    await recordDecision(harness, "stop");
  } else {
    const summary = harness.messages(SUMMARY_REQUEST_TYPE).at(-1);
    if (!summary) throw new Error("summary request not sent");
    harness.handlers.get("message_end")?.(customMessage(summary), harness.ctx);
  }
  await compactSuccessfully(harness);
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
  it("1. bare command opens the consolidated menu", async () => {
    const harness = createHarness();
    expect(harness.pi.registerCommand).toHaveBeenCalledWith(
      "supercompact",
      expect.anything(),
    );
    expect(harness.pi.registerCommand).not.toHaveBeenCalledWith(
      "supercompact-auto",
      expect.anything(),
    );
    expect(harness.command().description).toBe(
      "Prepare, force, abort, or manage automatic and agent-driven controls",
    );
    harness.ctx.ui.select.mockResolvedValue(undefined);

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.select).toHaveBeenCalledWith("Supercompact", [
      "Run pre-compaction wrap",
      "Force supercompaction now",
      "Allow agent-driven requests with confirmation for this session",
      "Allow agent-driven requests without confirmation for this session",
      "Allow the next agent-driven request without confirmation",
      "Deny agent-driven supercompaction requests for this session",
      "Enable automatic supercompact for this session",
      "Abort active pre-native supercompaction",
      "Cancel",
    ]);
  });

  it("selecting no-confirm in the menu enables the distinct session mode", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue(
      "Allow agent-driven requests without confirmation for this session",
    );

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm 🗜️ ",
    );
    await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("selecting one-shot no-confirm in the menu arms one request", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue(
      "Allow the next agent-driven request without confirmation",
    );

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm-once 🗜️ ",
    );
    const result = await confirmPreparation(harness);
    expect(result.details.authorization).toBe("one-shot-no-confirm");
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
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

  it("3. menu force opens the editor and starts the decision phase immediately", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue("Force supercompaction now");
    harness.ctx.ui.editor.mockResolvedValue("force context");

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.editor).toHaveBeenCalledOnce();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
    await beginDecision(harness);
    await recordDecision(harness, "stop");
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
    await beginDecision(harness);
    await recordDecision(harness, "stop");
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "first line\nsecond line",
    );
  });

  it("6. completion exposes every supported positional command", () => {
    const harness = createHarness();
    expect(harness.command().getArgumentCompletions("")).toEqual(
      [
        "run",
        "force",
        "auto-enable",
        "auto-disable",
        "agent-driven-allow",
        "agent-driven-allow-noconfirm",
        "agent-driven-allow-noconfirm-once",
        "agent-driven-deny",
        "abort",
      ].map((value) => ({
        value,
        label: value,
      })),
    );
  });

  it("7. removed, malformed, and legacy commands report the new usage without changing state", async () => {
    const harness = createHarness();
    for (const command of [
      "enable",
      "disable",
      "allow",
      "allow-noconfirm",
      "allow-noconfirm-once",
      "deny",
      "auto-enable extra",
      "auto-disable extra",
      "agent-driven-allow extra",
      "agent-driven-allow-noconfirm extra",
      "agent-driven-allow-noconfirm-once extra",
      "agent-driven-deny extra",
      "abort extra",
      "legacy bare context",
    ]) {
      await harness.command().handler(command, harness.ctx);
    }
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Usage: /supercompact [run [extra context] | force [extra context] | auto-enable | auto-disable | agent-driven-allow | agent-driven-allow-noconfirm | agent-driven-allow-noconfirm-once | agent-driven-deny | abort]",
      "error",
    );
  });

  it("8. run and force work headlessly while the menu requires UI", async () => {
    const harness = createHarness({ hasUI: false });
    await harness.command().handler("", harness.ctx);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);

    await harness.command().handler("run", harness.ctx);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);

    await harness.command().handler("force headless", harness.ctx);
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
  });
});

describe("configuration and live-session permission", () => {
  it("9. missing config defaults to denied while both schemas stay active", async () => {
    const harness = createHarness();
    expect(harness.activeTools()).toEqual([
      "read",
      "bash",
      DECISION_TOOL_NAME,
      AGENT_TOOL_NAME,
    ]);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      /\/supercompact (run|agent-driven-allow|agent-driven-allow-noconfirm|agent-driven-allow-noconfirm-once)/,
    );
  });

  it("10. global true and false control permission, not schemas", async () => {
    const allowed = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
    });
    const denied = createHarness({
      globalConfig: '{"agentRequestsAllowed":false}',
    });
    expect(allowed.activeTools()).toEqual(denied.activeTools());
    await expect(confirmPreparation(allowed)).resolves.toMatchObject({
      details: { status: "queued" },
    });
    await expect(confirmPreparation(denied)).rejects.toThrow("not authorized");
  });

  it("11. trusted project permission overrides global permission", async () => {
    const allowed = createHarness({
      globalConfig: '{"agentRequestsAllowed":false}',
      projectConfig: '{"agentRequestsAllowed":true}',
    });
    const denied = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
      projectConfig: '{"agentRequestsAllowed":false}',
    });
    await expect(confirmPreparation(allowed)).resolves.toMatchObject({
      details: { status: "queued" },
    });
    await expect(confirmPreparation(denied)).rejects.toThrow("not authorized");
    expect(allowed.activeTools()).toEqual(denied.activeTools());
  });

  it("12. untrusted project config is ignored", async () => {
    const harness = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
      projectConfig: '{"agentRequestsAllowed":false}',
      projectTrusted: false,
    });
    await expect(confirmPreparation(harness)).resolves.toMatchObject({
      details: { status: "queued" },
    });
  });

  it("13. invalid and unrecognized permission config fail closed", async () => {
    const invalid = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
      projectConfig: '{"agentRequestsAllowed":"yes"}',
    });
    const unrecognized = createHarness({
      globalConfig: '{"unrecognizedPermission":true}',
    });
    await expect(confirmPreparation(invalid)).rejects.toThrow("not authorized");
    await expect(confirmPreparation(unrecognized)).rejects.toThrow(
      "not authorized",
    );
    expect(invalid.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid supercompact config"),
      "warning",
    );
    expect(invalid.activeTools()).toEqual(unrecognized.activeTools());
  });

  it("14. allow overrides configured false only in memory", async () => {
    const harness = createHarness({
      globalConfig: '{"agentRequestsAllowed":false}',
    });
    const reads = readFileSyncMock.mock.calls.length;
    await harness.command().handler("agent-driven-allow", harness.ctx);
    expect(readFileSyncMock.mock.calls).toHaveLength(reads);
    await expect(confirmPreparation(harness)).resolves.toMatchObject({
      details: { status: "queued" },
    });
  });

  it("15. deny overrides configured true only in memory", async () => {
    const harness = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
    });
    const reads = readFileSyncMock.mock.calls.length;
    await harness.command().handler("agent-driven-deny", harness.ctx);
    expect(readFileSyncMock.mock.calls).toHaveLength(reads);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "explicitly denied",
    );
  });

  it("16. non-reload session initialization discards overrides and reapplies config", async () => {
    const harness = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
    });
    await harness.command().handler("agent-driven-deny", harness.ctx);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "explicitly denied",
    );
    harness.handlers.get("session_start")?.({ reason: "resume" }, harness.ctx);
    await expect(confirmPreparation(harness)).resolves.toMatchObject({
      details: { status: "queued" },
    });
  });

  it("17. repeated allow and deny keep stable, unique schemas", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    await harness.command().handler("agent-driven-allow", harness.ctx);
    await harness.command().handler("agent-driven-deny", harness.ctx);
    await harness.command().handler("agent-driven-deny", harness.ctx);
    expect(harness.activeTools()).toEqual(initialTools);
    expect(
      harness.activeTools().filter((name) => name === AGENT_TOOL_NAME),
    ).toHaveLength(1);
    expect(
      harness.activeTools().filter((name) => name === DECISION_TOOL_NAME),
    ).toHaveLength(1);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("shows permission status only for explicit live-session overrides", async () => {
    const harness = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });

    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );

    await harness.command().handler("agent-driven-deny", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );

    await harness
      .command()
      .handler("agent-driven-allow-noconfirm", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm 🗜️ ",
    );

    await harness.command().handler("agent-driven-deny", harness.ctx);
    await harness.command().handler("agent-driven-allow", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow 🗜️ ",
    );
  });

  it("applies the global and agent-specific confirmation matrix", async () => {
    const cases = [
      {
        config: '{"agentRequestsAllowed":true}',
        expectsConfirmation: true,
      },
      {
        config: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
        expectsConfirmation: false,
      },
      {
        config:
          '{"requireConfirmation":false,"agentRequestsAllowed":true,"agentRequestsRequireConfirmation":true}',
        expectsConfirmation: true,
      },
      {
        config:
          '{"requireConfirmation":true,"agentRequestsAllowed":true,"agentRequestsRequireConfirmation":false}',
        expectsConfirmation: false,
      },
    ];

    for (const { config, expectsConfirmation } of cases) {
      const harness = createHarness({ globalConfig: config });
      const result = await confirmPreparation(harness);
      expect(harness.ctx.ui.confirm.mock.calls.length > 0).toBe(
        expectsConfirmation,
      );
      if (!expectsConfirmation) {
        expect(result.details.authorization).toBe("configured-no-confirm");
      }
    }
  });

  it("prepared run bypasses confirmation regardless of configuration", async () => {
    const headless = createHarness({
      hasUI: false,
      globalConfig:
        '{"requireConfirmation":false,"agentRequestsAllowed":true,"agentRequestsRequireConfirmation":true}',
    });
    await beginPreparation(headless);
    const headlessResult = await confirmPreparation(headless);
    expect(headless.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(headlessResult.details.authorization).toBe("prepared-no-confirm");

    const confirmRequired = createHarness({
      globalConfig:
        '{"requireConfirmation":true,"agentRequestsAllowed":true,"agentRequestsRequireConfirmation":false}',
    });
    await beginPreparation(confirmRequired);
    const result = await confirmPreparation(confirmRequired);
    expect(confirmRequired.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details.authorization).toBe("prepared-no-confirm");
  });

  it("lets confirmation-only config govern run without granting requests", async () => {
    const harness = createHarness({
      hasUI: false,
      globalConfig: '{"requireConfirmation":false}',
    });
    await expect(confirmPreparation(harness)).rejects.toThrow("not authorized");
    await beginPreparation(harness);
    await expect(confirmPreparation(harness)).resolves.toMatchObject({
      details: { authorization: "prepared-no-confirm" },
    });
  });

  it("treats trusted project configuration as one overriding policy", async () => {
    const harness = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
      projectConfig: '{"requireConfirmation":true}',
    });
    await expect(confirmPreparation(harness)).rejects.toThrow("not authorized");
    await beginPreparation(harness);
    const result = await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details.authorization).toBe("prepared-no-confirm");
  });

  it("fails closed for invalid confirmation settings", async () => {
    for (const invalidProperty of [
      "requireConfirmation",
      "agentRequestsRequireConfirmation",
    ]) {
      const harness = createHarness({
        globalConfig: JSON.stringify({
          agentRequestsAllowed: true,
          [invalidProperty]: "no",
        }),
      });
      await expect(confirmPreparation(harness)).rejects.toThrow(
        "not authorized",
      );
      expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(`${invalidProperty} must be true or false`),
        "warning",
      );
    }
  });

  it("restores configured no-confirm after session overrides on a non-reload initialization", async () => {
    const harness = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await harness.command().handler("agent-driven-allow", harness.ctx);
    harness.handlers.get("session_start")?.({ reason: "resume" }, harness.ctx);
    const result = await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details.authorization).toBe("configured-no-confirm");
  });

  it("session modes override configured confirmation for agent calls while a prepared run stays its own authorization", async () => {
    const require = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await require.command().handler("agent-driven-allow", require.ctx);
    await confirmPreparation(require);
    expect(require.ctx.ui.confirm).toHaveBeenCalledOnce();

    const waive = createHarness({
      globalConfig: '{"requireConfirmation":true,"agentRequestsAllowed":true}',
    });
    await waive.command().handler("agent-driven-allow-noconfirm", waive.ctx);
    await confirmPreparation(waive);
    expect(waive.ctx.ui.confirm).not.toHaveBeenCalled();

    const preparedWaive = createHarness({
      globalConfig: '{"requireConfirmation":true}',
    });
    await beginPreparation(preparedWaive);
    await preparedWaive
      .command()
      .handler("agent-driven-allow-noconfirm", preparedWaive.ctx);
    await confirmPreparation(preparedWaive);
    expect(preparedWaive.ctx.ui.confirm).not.toHaveBeenCalled();

    const preparedRequire = createHarness({
      globalConfig: '{"requireConfirmation":true}',
    });
    await beginPreparation(preparedRequire);
    await preparedRequire
      .command()
      .handler("agent-driven-allow", preparedRequire.ctx);
    const preparedRequireResult = await confirmPreparation(preparedRequire);
    expect(preparedRequire.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(preparedRequireResult.details.authorization).toBe(
      "prepared-no-confirm",
    );

    const configuredDenied = createHarness({
      hasUI: false,
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await configuredDenied
      .command()
      .handler("agent-driven-deny", configuredDenied.ctx);
    await expect(confirmPreparation(configuredDenied)).rejects.toThrow(
      "explicitly denied",
    );
    expect(configuredDenied.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);

    const oneOff = createHarness({
      hasUI: false,
      globalConfig: '{"requireConfirmation":false}',
    });
    await oneOff.command().handler("agent-driven-deny", oneOff.ctx);
    await beginPreparation(oneOff);
    await expect(confirmPreparation(oneOff)).resolves.toMatchObject({
      details: { authorization: "prepared-no-confirm" },
    });
  });
});

describe("session-only no-confirm permission", () => {
  it("allows requests without a dialog and reports the authorization", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    const reads = readFileSyncMock.mock.calls.length;

    await harness
      .command()
      .handler("agent-driven-allow-noconfirm", harness.ctx);
    const result = await confirmPreparation(harness);

    expect(readFileSyncMock.mock.calls).toHaveLength(reads);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "Explicit live-session no-confirm permission authorized",
    );
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).not.toContain(
      "Agent-supplied summary emphasis confirmed by the user",
    );
    expect(result.content[0].text).toMatch(
      /live-session no-confirm permission.*without a confirmation dialog/i,
    );
    expect(result.details).toMatchObject({
      status: "queued",
      authorization: "session-no-confirm",
    });
    expect(harness.ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm 🗜️ ",
    );
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Supercompaction is proceeding under live-session no-confirm permission. No additional approval is required.",
      "info",
    );
    expect(harness.activeTools()).toEqual(initialTools);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("works headlessly while retaining validation and workflow gates", async () => {
    const headless = createHarness({ hasUI: false });
    await headless
      .command()
      .handler("agent-driven-allow-noconfirm", headless.ctx);
    await expect(confirmPreparation(headless)).resolves.toMatchObject({
      details: { authorization: "session-no-confirm" },
    });
    expect(headless.ctx.ui.confirm).not.toHaveBeenCalled();

    const empty = createHarness({ hasUI: false });
    await empty.command().handler("agent-driven-allow-noconfirm", empty.ctx);
    await expect(
      confirmPreparation(empty, { nextAction: "   " }),
    ).rejects.toThrow("Supply one concrete next action");

    const busy = createHarness({ hasUI: false });
    await busy.command().handler("agent-driven-allow-noconfirm", busy.ctx);
    await confirmPreparation(busy);
    await expect(confirmPreparation(busy)).rejects.toThrow(
      "already in progress",
    );

    const unavailable = createHarness({
      hasUI: false,
      allowDecisionTool: false,
    });
    await unavailable
      .command()
      .handler("agent-driven-allow-noconfirm", unavailable.ctx);
    await expect(confirmPreparation(unavailable)).resolves.toMatchObject({
      details: { status: "queued" },
    });
    expect(unavailable.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("keeps normal allow confirmation-required and deny revokes both modes", async () => {
    const allowed = createHarness();
    await allowed
      .command()
      .handler("agent-driven-allow-noconfirm", allowed.ctx);
    await allowed.command().handler("agent-driven-allow", allowed.ctx);
    await confirmPreparation(allowed);
    expect(allowed.ctx.ui.confirm).toHaveBeenCalledOnce();

    const deniedNoConfirm = createHarness();
    await deniedNoConfirm
      .command()
      .handler("agent-driven-allow-noconfirm", deniedNoConfirm.ctx);
    await deniedNoConfirm
      .command()
      .handler("agent-driven-deny", deniedNoConfirm.ctx);
    await expect(confirmPreparation(deniedNoConfirm)).rejects.toThrow(
      "explicitly denied",
    );
    expect(deniedNoConfirm.ctx.ui.confirm).not.toHaveBeenCalled();

    const deniedAllowed = createHarness();
    await deniedAllowed
      .command()
      .handler("agent-driven-allow", deniedAllowed.ctx);
    await deniedAllowed
      .command()
      .handler("agent-driven-deny", deniedAllowed.ctx);
    await expect(confirmPreparation(deniedAllowed)).rejects.toThrow(
      "explicitly denied",
    );
  });

  it("restores each explicit session mode and its status after reload", async () => {
    const noConfirm = createHarness({
      globalConfig: '{"agentRequestsAllowed":false}',
    });
    await noConfirm
      .command()
      .handler("agent-driven-allow-noconfirm", noConfirm.ctx);
    expect(noConfirm.pi.appendEntry).toHaveBeenCalledWith(
      SESSION_PERMISSION_ENTRY_TYPE,
      { permission: "allowed-noconfirm" },
    );
    noConfirm.handlers.get("session_start")?.(
      { reason: "reload" },
      noConfirm.ctx,
    );
    await confirmPreparation(noConfirm);
    expect(noConfirm.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(noConfirm.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm 🗜️ ",
    );

    const allowed = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await allowed.command().handler("agent-driven-allow", allowed.ctx);
    allowed.handlers.get("session_start")?.({ reason: "reload" }, allowed.ctx);
    await confirmPreparation(allowed);
    expect(allowed.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(allowed.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow 🗜️ ",
    );

    const denied = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await denied.command().handler("agent-driven-deny", denied.ctx);
    denied.handlers.get("session_start")?.({ reason: "reload" }, denied.ctx);
    await expect(confirmPreparation(denied)).rejects.toThrow(
      "explicitly denied",
    );
    expect(denied.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );
  });

  it("prepared run never opens a confirmation dialog", async () => {
    const headless = createHarness({ hasUI: false });
    await headless
      .command()
      .handler("agent-driven-allow-noconfirm", headless.ctx);
    await beginPreparation(headless, "preserve this context");
    await confirmPreparation(headless);
    expect(headless.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(headless.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    expect(headless.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "preserve this context",
    );

    const sessionAllow = createHarness();
    await sessionAllow
      .command()
      .handler("agent-driven-allow", sessionAllow.ctx);
    await beginPreparation(sessionAllow);
    const result = await confirmPreparation(sessionAllow);
    expect(sessionAllow.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details.authorization).toBe("prepared-no-confirm");
  });

  it("keeps schemas stable through no-confirm settlement and denial", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await harness
      .command()
      .handler("agent-driven-allow-noconfirm", harness.ctx);
    await confirmPreparation(harness);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
    harness.handlers.get("message_end")?.(
      customMessage(harness.messages(SUMMARY_REQUEST_TYPE)[0]),
      harness.ctx,
    );
    await harness.command().handler("agent-driven-deny", harness.ctx);
    await compactSuccessfully(harness);
    const restored = harness.messages(CONTEXT_MESSAGE_TYPE)[0];
    expect(restored.details.preparation.authorization).toBe(
      "session-no-confirm",
    );
    expect(restored.content).toContain(
      "Authorization: live-session no-confirm permission",
    );
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "explicitly denied",
    );
    harness.handlers.get("session_shutdown")?.({}, harness.ctx);

    expect(harness.activeTools()).toEqual(initialTools);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });
});

describe("one-shot no-confirm permission", () => {
  it("overlays denial or confirmation permission once, then restores it", async () => {
    const configuredDenied = createHarness();
    await configuredDenied
      .command()
      .handler("agent-driven-allow-noconfirm-once", configuredDenied.ctx);
    const configuredDeniedResult = await confirmPreparation(configuredDenied);
    expect(configuredDeniedResult.details.authorization).toBe(
      "one-shot-no-confirm",
    );
    expect(configuredDenied.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(configuredDenied.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );
    await finishQueuedSupercompact(configuredDenied);
    await expect(confirmPreparation(configuredDenied)).rejects.toThrow(
      "not authorized",
    );

    const configuredConfirm = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
    });
    await configuredConfirm
      .command()
      .handler("agent-driven-allow-noconfirm-once", configuredConfirm.ctx);
    await confirmPreparation(configuredConfirm);
    await finishQueuedSupercompact(configuredConfirm);
    await confirmPreparation(configuredConfirm);
    expect(configuredConfirm.ctx.ui.confirm).toHaveBeenCalledOnce();

    const explicitlyDenied = createHarness();
    await explicitlyDenied
      .command()
      .handler("agent-driven-deny", explicitlyDenied.ctx);
    await explicitlyDenied
      .command()
      .handler("agent-driven-allow-noconfirm-once", explicitlyDenied.ctx);
    await confirmPreparation(explicitlyDenied);
    await finishQueuedSupercompact(explicitlyDenied);
    await expect(confirmPreparation(explicitlyDenied)).rejects.toThrow(
      "explicitly denied",
    );

    const explicitlyAllowed = createHarness();
    await explicitlyAllowed
      .command()
      .handler("agent-driven-allow", explicitlyAllowed.ctx);
    await explicitlyAllowed
      .command()
      .handler("agent-driven-allow-noconfirm-once", explicitlyAllowed.ctx);
    await confirmPreparation(explicitlyAllowed);
    expect(explicitlyAllowed.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow 🗜️ ",
    );
    await finishQueuedSupercompact(explicitlyAllowed);
    await confirmPreparation(explicitlyAllowed);
    expect(explicitlyAllowed.ctx.ui.confirm).toHaveBeenCalledOnce();
  });

  it("warns and does not arm when effective permission already skips confirmation", async () => {
    const configured = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await configured
      .command()
      .handler("agent-driven-allow-noconfirm-once", configured.ctx);
    expect(configured.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("already allowed without confirmation"),
      "warning",
    );
    expect(configured.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );
    await expect(confirmPreparation(configured)).resolves.toMatchObject({
      details: { authorization: "configured-no-confirm" },
    });

    const liveSession = createHarness();
    await liveSession
      .command()
      .handler("agent-driven-allow-noconfirm", liveSession.ctx);
    await liveSession
      .command()
      .handler("agent-driven-allow-noconfirm-once", liveSession.ctx);
    expect(liveSession.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("already allowed without confirmation"),
      "warning",
    );
    expect(liveSession.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm 🗜️ ",
    );
    await expect(confirmPreparation(liveSession)).resolves.toMatchObject({
      details: { authorization: "session-no-confirm" },
    });

    const overriddenConfig = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await overriddenConfig
      .command()
      .handler("agent-driven-deny", overriddenConfig.ctx);
    await overriddenConfig
      .command()
      .handler("agent-driven-allow-noconfirm-once", overriddenConfig.ctx);
    expect(overriddenConfig.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm-once 🗜️ ",
    );
  });

  it("keeps the grant armed through validation, availability, and queue failures", async () => {
    const invalid = createHarness();
    await invalid
      .command()
      .handler("agent-driven-allow-noconfirm-once", invalid.ctx);
    await expect(
      confirmPreparation(invalid, { nextAction: "   " }),
    ).rejects.toThrow("Supply one concrete next action");
    expect(invalid.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm-once 🗜️ ",
    );
    await expect(confirmPreparation(invalid)).resolves.toMatchObject({
      details: { authorization: "one-shot-no-confirm" },
    });

    const unavailable = createHarness({ allowDecisionTool: false });
    await unavailable
      .command()
      .handler("agent-driven-allow-noconfirm-once", unavailable.ctx);
    await expect(confirmPreparation(unavailable)).resolves.toMatchObject({
      details: { status: "queued" },
    });
    expect(unavailable.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
    expect(unavailable.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );

    const queueFailure = createHarness();
    await queueFailure
      .command()
      .handler("agent-driven-allow-noconfirm-once", queueFailure.ctx);
    queueFailure.pi.sendMessage.mockImplementationOnce(() => {
      throw new Error("one-shot queue failed");
    });
    await expect(confirmPreparation(queueFailure)).rejects.toThrow(
      "one-shot queue failed",
    );
    expect(queueFailure.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm-once 🗜️ ",
    );
    await expect(confirmPreparation(queueFailure)).resolves.toMatchObject({
      details: { authorization: "one-shot-no-confirm" },
    });
  });

  it("does not arm while another workflow is active", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);
    await harness
      .command()
      .handler("agent-driven-allow-noconfirm-once", harness.ctx);
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("already active"),
      "warning",
    );
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("abort, agent-driven denial, and superseding commands clear an unused grant", async () => {
    const aborted = createHarness();
    await aborted
      .command()
      .handler("agent-driven-allow-noconfirm-once", aborted.ctx);
    await aborted.command().handler("abort", aborted.ctx);
    expect(aborted.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Pending one-shot no-confirm permission was canceled.",
      "info",
    );
    await expect(confirmPreparation(aborted)).rejects.toThrow(
      /\/supercompact (run|agent-driven-allow|agent-driven-allow-noconfirm|agent-driven-allow-noconfirm-once)/,
    );

    const denied = createHarness();
    await denied
      .command()
      .handler("agent-driven-allow-noconfirm-once", denied.ctx);
    await denied.command().handler("agent-driven-deny", denied.ctx);
    await expect(confirmPreparation(denied)).rejects.toThrow(
      "explicitly denied",
    );

    const run = createHarness();
    await run.command().handler("agent-driven-allow-noconfirm-once", run.ctx);
    await beginPreparation(run);
    const runResult = await confirmPreparation(run);
    expect(run.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(runResult.details.authorization).toBe("prepared-no-confirm");

    const force = createHarness();
    await force
      .command()
      .handler("agent-driven-allow-noconfirm-once", force.ctx);
    await force.command().handler("force", force.ctx);
    expect(force.messages(DECISION_REQUEST_TYPE)[0].content).not.toContain(
      "one-shot no-confirm permission",
    );

    const allowed = createHarness();
    await allowed
      .command()
      .handler("agent-driven-allow-noconfirm-once", allowed.ctx);
    await allowed.command().handler("agent-driven-allow", allowed.ctx);
    await confirmPreparation(allowed);
    expect(allowed.ctx.ui.confirm).toHaveBeenCalledOnce();

    const noConfirm = createHarness();
    await noConfirm
      .command()
      .handler("agent-driven-allow-noconfirm-once", noConfirm.ctx);
    await noConfirm
      .command()
      .handler("agent-driven-allow-noconfirm", noConfirm.ctx);
    await expect(confirmPreparation(noConfirm)).resolves.toMatchObject({
      details: { authorization: "session-no-confirm" },
    });
  });

  it("lifecycle replacement clears rather than persists an unused grant", async () => {
    for (const event of [
      { name: "session_start", payload: { reason: "reload" } },
      { name: "session_start", payload: { reason: "resume" } },
      { name: "session_shutdown", payload: {} },
    ]) {
      const harness = createHarness();
      await harness
        .command()
        .handler("agent-driven-allow-noconfirm-once", harness.ctx);
      expect(harness.pi.appendEntry).not.toHaveBeenCalled();
      harness.handlers.get(event.name)?.(event.payload, harness.ctx);
      expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
        "Pending one-shot no-confirm permission was canceled.",
        "info",
      );
      await expect(confirmPreparation(harness)).rejects.toThrow(
        "not authorized",
      );
    }
  });

  it("works headlessly with stable schemas and preserves authorization metadata", async () => {
    const harness = createHarness({ hasUI: false });
    const initialTools = harness.activeTools();
    await harness
      .command()
      .handler("agent-driven-allow-noconfirm-once", harness.ctx);
    const result = await confirmPreparation(harness, {
      extraContext: "retain the one-shot boundary",
    });

    expect(result).toMatchObject({
      details: { authorization: "one-shot-no-confirm", status: "queued" },
    });
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    const summary = harness.messages(SUMMARY_REQUEST_TYPE)[0];
    expect(summary.content).toContain(
      "One-shot no-confirm permission authorized",
    );
    expect(summary.content).toContain(
      "Authorization: one-shot no-confirm permission",
    );
    harness.handlers.get("message_end")?.(customMessage(summary), harness.ctx);
    await compactSuccessfully(harness);
    const restored = harness.messages(CONTEXT_MESSAGE_TYPE)[0];
    expect(restored.details.preparation.authorization).toBe(
      "one-shot-no-confirm",
    );
    expect(restored.content).toContain(
      "Authorization: one-shot no-confirm permission",
    );
    expect(harness.activeTools()).toEqual(initialTools);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });
});

describe("preparation", () => {
  it("18. run creates one grant and sends focused idle steering", async () => {
    const harness = createHarness();
    const message = await beginPreparation(harness);
    expect(message.content).toContain("focused pre-compaction checkpoint");
    expect(message.content).toContain("Refresh relevant context");
    expect(message.content).toContain("Close the active boundary");
    expect(harness.messageCalls(PREPARATION_REQUEST_TYPE)[0][1]).toEqual({
      triggerTurn: true,
      deliverAs: "steer",
    });
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: preparing 🗜️ ",
    );
  });

  it("19. run while busy queues steering without a redundant turn", async () => {
    const harness = createHarness({ idle: false });
    await beginPreparation(harness);
    expect(harness.messageCalls(PREPARATION_REQUEST_TYPE)[0][1]).toEqual({
      deliverAs: "steer",
    });
  });

  it("automatic preparation identifies its threshold trigger", () => {
    const prompt = buildPreparationPrompt("", true);
    expect(prompt).toContain(
      "Automatic supercompact was triggered because context usage crossed a configured threshold",
    );
    expect(prompt).toContain(
      "the user did not manually request this checkpoint",
    );
    expect(prompt).not.toContain(
      "The user supplied no extra preparation context.",
    );
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
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("23. deny cancels an unused preparation grant without changing schemas", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparation(harness);
    await harness.command().handler("agent-driven-deny", harness.ctx);
    expect(harness.activeTools()).toEqual(initialTools);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Pending pre-compaction preparation was canceled.",
      "info",
    );
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "explicitly denied",
    );
  });

  it("24. session lifecycle clears preparation and confirmation state", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    harness.ctx.ui.confirm.mockImplementationOnce(
      (_title: string, _message: string, options: { signal: AbortSignal }) =>
        new Promise<boolean>((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("session replaced")),
            { once: true },
          ),
        ),
    );
    const pending = confirmPreparation(harness);
    harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);
    expect((await pending).details.status).toBe("revoked");
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);

    const shutdown = createHarness();
    await beginPreparation(shutdown);
    shutdown.handlers.get("session_shutdown")?.({}, shutdown.ctx);
    expect(shutdown.activeTools()).toContain(AGENT_TOOL_NAME);
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
  it("26. agent calls are rejected while denied without a grant", async () => {
    const harness = createHarness();
    await expect(confirmPreparation(harness)).rejects.toThrow("not authorized");
  });

  it("27. confirmation shows continuation, next action, and agent context", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    await confirmPreparation(harness, {
      continuation: "stop",
      nextAction: "Wait for the user.",
      extraContext: "summary detail",
    });
    expect(harness.ctx.ui.confirm).toHaveBeenCalledWith(
      "Confirm agent-driven supercompaction",
      [
        "Post-compaction behavior: stop and wait",
        "Next action: Wait for the user.",
        "Additional summary context: summary detail",
        "Confirming will begin the canonical super-summary and native compaction immediately.",
      ].join("\n\n"),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("27a. confirmation truncates agent values while keeping them complete in the summary", async () => {
    const nextAction =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const extraContext =
      "red orange yellow green blue indigo violet black white gray silver gold";
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    await confirmPreparation(harness, { nextAction, extraContext });

    const dialog = harness.ctx.ui.confirm.mock.calls[0][1];
    expect(dialog).toContain(
      "Next action: alpha beta gamma delta epsilon zeta eta theta iota kappa…",
    );
    expect(dialog).toContain(
      "Additional summary context: red orange yellow green blue indigo violet black white gray…",
    );
    expect(dialog.split("\n\n")).toHaveLength(4);
    expect(dialog).not.toContain("\n\n\n");

    const summaryPrompt = harness.messages(SUMMARY_REQUEST_TYPE)[0].content;
    expect(summaryPrompt).toContain(nextAction);
    expect(summaryPrompt).toContain(extraContext);
  });

  it("28. confirmation acceptance starts exactly one summary", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("prepared requests use their recorded continuation without a second decision turn", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    await confirmPreparation(harness, {
      continuation: "stop",
      nextAction: "Wait for the user.",
    });

    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "Recorded continuation decision: stop",
    );
  });

  it("29. confirmation decline starts no summary or compaction", async () => {
    const harness = createHarness({ confirmed: false });
    await harness.command().handler("agent-driven-allow", harness.ctx);
    const result = await confirmPreparation(harness);
    expect(result.details.status).toBe("declined");
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
  });

  it("30. decline keeps session permission and schemas stable", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    harness.ctx.ui.confirm.mockResolvedValueOnce(false);
    await confirmPreparation(harness);
    expect(harness.activeTools()).toEqual(initialTools);
    const retry = await confirmPreparation(harness);
    expect(retry.details.status).toBe("queued");
  });

  it("31. decline under session allow retains policy and directs waiting", async () => {
    const harness = createHarness({ confirmed: false });
    await harness.command().handler("agent-driven-allow", harness.ctx);
    const result = await confirmPreparation(harness);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(result.content[0].text).toContain("Do not retry automatically");
  });

  it("32. confirmation fails closed without UI", async () => {
    const harness = createHarness({
      hasUI: false,
      globalConfig: '{"agentRequestsAllowed":true}',
    });
    await expect(confirmPreparation(harness)).rejects.toThrow(
      /requires TUI or RPC confirmation.*\/supercompact force explicitly/,
    );
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
  });

  it("33. concurrent calls cannot open multiple dialogs or workflows", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const first = confirmPreparation(harness);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: awaiting confirmation 🗜️ ",
    );
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "already awaiting the user's response",
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
    await beginPreparation(harness);
    await confirmPreparation(harness, {
      continuation: "stop",
      nextAction: "Wait for the user.",
    });
    const summary = harness.messages(SUMMARY_REQUEST_TYPE)[0];
    expect(summary.content).toContain("Recorded continuation decision: stop");
    harness.handlers.get("message_end")?.(customMessage(summary), harness.ctx);
    await recordSummaryDecision(harness, "stop");
  });

  it("36. authorized continue may conservatively downgrade to stop", async () => {
    const harness = createHarness();
    const request = await beginPreparedSummary(harness);
    expect(request.content).toContain(
      "Recorded continuation decision: continue",
    );
    await recordSummaryDecision(harness, "stop");
  });
});

describe("force path", () => {
  it("37. force starts the decision phase without preparation or confirmation", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("records the decision before the long handoff and compacts after summary prose alone", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);

    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);

    await beginDecision(harness);
    await recordDecision(harness, "stop");
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).not.toContain(
      `Call ${DECISION_TOOL_NAME}`,
    );

    await recordSummaryDecision(harness, "stop", {
      text: "## Next action\nWait for the user.",
    });
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
  });

  it("38. force remains usable while agent requests are denied", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-deny", harness.ctx);
    await harness.command().handler("force", harness.ctx);
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("39. force rejects during confirmation and another workflow", async () => {
    const confirmationHarness = createHarness();
    await confirmationHarness
      .command()
      .handler("agent-driven-allow", confirmationHarness.ctx);
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
    expect(active.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("40. force retains busy steering and extra-context behavior", async () => {
    const harness = createHarness({ idle: false });
    await harness.command().handler("force preserve this", harness.ctx);
    const [, options] = harness.messageCalls(DECISION_REQUEST_TYPE)[0];
    expect(options).toEqual({ deliverAs: "steer" });
    await beginDecision(harness);
    await recordDecision(harness, "stop");
    expect(harness.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "preserve this",
    );
  });
});

describe("abort command", () => {
  it("reports idle abort as a normal Pi error notification", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();

    await harness.command().handler("abort", harness.ctx);

    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "No supercompaction is active.",
      "error",
    );
    expect(harness.activeTools()).toEqual(initialTools);
  });

  it("supports abort from the command menu", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue(
      "Abort active pre-native supercompaction",
    );

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "No supercompaction is active.",
      "error",
    );
  });

  it("cancels active preparation and preserves permission and schemas", async () => {
    const harness = createHarness({ idle: false });
    const initialTools = harness.activeTools();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    await beginPreparation(harness);

    await harness.command().handler("abort", harness.ctx);

    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Supercompaction was aborted before native compaction began.",
      "info",
    );
    expect(harness.activeTools()).toEqual(initialTools);
    await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).toHaveBeenCalledOnce();
  });

  it("cancels an open confirmation without starting summary", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const pending = confirmPreparation(harness);

    await harness.command().handler("abort", harness.ctx);
    confirmation.resolve(true);

    await expect(pending).resolves.toMatchObject({
      details: { status: "aborted" },
    });
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
  });

  it("cancels queued and active canonical-summary work", async () => {
    const queued = createHarness();
    await queued.command().handler("force", queued.ctx);
    const queuedMessage = queued.messages(DECISION_REQUEST_TYPE)[0];
    await queued.command().handler("abort", queued.ctx);
    queued.handlers.get("message_end")?.(
      customMessage(queuedMessage),
      queued.ctx,
    );
    queued.handlers.get("agent_settled")?.({}, queued.ctx);
    expect(queued.ctx.abort).toHaveBeenCalledOnce();
    expect(queued.ctx.compact).not.toHaveBeenCalled();

    const active = createHarness();
    await beginForceSummary(active);
    await active.command().handler("abort", active.ctx);
    await expect(executeDecision(active, "stop")).resolves.toEqual({
      content: [],
      details: { ignored: true },
    });
    active.handlers.get("agent_settled")?.({}, active.ctx);
    expect(active.ctx.abort).toHaveBeenCalledOnce();
    expect(active.ctx.compact).not.toHaveBeenCalled();
  });

  it("cancels a recorded summary before native compaction starts", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    await recordSummaryDecision(harness, "stop");

    await harness.command().handler("abort", harness.ctx);
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.ctx.compact).not.toHaveBeenCalled();
  });

  it("delegates cancellation after native compaction starts to the host", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();

    await harness.command().handler("abort", harness.ctx);

    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringMatching(/Press Escape.*native cancellation mechanism/),
      "warning",
    );
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });
});

describe("workflow and caching-sensitive state", () => {
  it("41. both schemas stay active through summary validation", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparedSummary(harness);
    await recordSummaryDecision(harness, "stop");
    expect(harness.activeTools()).toEqual(initialTools);
  });

  it("42. successful compaction keeps the active tool vector stable", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparedSummary(harness);
    await compactSuccessfully(harness);
    expect(harness.activeTools()).toEqual(initialTools);
  });

  it("43. workflow failure keeps the active tool vector stable", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparedSummary(harness);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    harness.ctx.compact.mock.calls[0][0].onError(new Error("provider failed"));
    expect(harness.activeTools()).toEqual(initialTools);
  });

  it("44. session allow remains active after workflow success and failure", async () => {
    const success = createHarness();
    await success.command().handler("agent-driven-allow", success.ctx);
    await beginPreparedSummary(success);
    await compactSuccessfully(success);
    expect(success.activeTools()).toContain(AGENT_TOOL_NAME);

    const failure = createHarness();
    await failure.command().handler("agent-driven-allow", failure.ctx);
    await beginPreparedSummary(failure);
    await recordSummaryDecision(failure, "stop");
    failure.handlers.get("agent_settled")?.({}, failure.ctx);
    failure.ctx.compact.mock.calls[0][0].onError(new Error("failed"));
    expect(failure.activeTools()).toContain(AGENT_TOOL_NAME);
  });

  it("45. deny during preparation revokes access without changing schemas", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparation(harness);
    await harness.command().handler("agent-driven-deny", harness.ctx);
    expect(harness.activeTools()).toEqual(initialTools);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "explicitly denied",
    );
  });

  it("46. deny during active summary revokes future access without corruption", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparedSummary(harness);
    await harness.command().handler("agent-driven-deny", harness.ctx);
    expect(harness.activeTools()).toEqual(initialTools);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
  });

  it("47. internal decision cleanup leaves both schemas active", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    await beginPreparedSummary(harness);
    await recordSummaryDecision(harness, "stop");
    expect(harness.activeTools()).toEqual(initialTools);
  });

  it("48. continuation, auto-compaction, retries, filtering, and failure cleanup regressions pass", async () => {
    const automatic = createHarness();
    await beginForceSummary(automatic);
    await recordSummaryDecision(automatic, "stop", {
      text: "## State\nDone.",
    });
    automatic.handlers.get("session_compact")?.({}, automatic.ctx);
    automatic.handlers.get("agent_settled")?.({}, automatic.ctx);
    expect(automatic.ctx.compact).not.toHaveBeenCalled();
    expect(automatic.messages(CONTEXT_MESSAGE_TYPE)).toHaveLength(1);

    const correction = createHarness();
    await beginForceSummary(correction);
    correction.handlers.get("message_end")?.(
      assistantMessage("## State\nCaptured.", [
        { id: "unexpected-tool", name: "bash" },
      ]),
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
    expect(failure.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(failure.activeTools()).toContain(DECISION_TOOL_NAME);
    expect(failure.ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(failure.pi.setActiveTools).not.toHaveBeenCalled();
  });
});

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
    const preparationTools = preparation.activeTools();
    await preparation.command().handler("run", preparation.ctx);
    expect(preparation.activeTools()).toEqual(preparationTools);
    expect(preparation.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompact preparation failed: queue failed. No automatic retry will occur.",
      "error",
    );

    const summary = createHarness();
    await beginPreparation(summary);
    summary.pi.sendMessage.mockImplementationOnce(() => {
      throw new Error("summary queue failed");
    });
    const summaryTools = summary.activeTools();
    await expect(confirmPreparation(summary)).rejects.toThrow(
      "summary queue failed. No automatic retry will occur",
    );
    expect(summary.activeTools()).toEqual(summaryTools);
  });

  it("cleans up a synchronous native compaction failure", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    await recordSummaryDecision(harness, "stop");
    harness.ctx.compact.mockImplementationOnce(() => {
      throw new Error("compact threw");
    });
    const initialTools = harness.activeTools();
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.activeTools()).toEqual(initialTools);
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompact failed: compact threw. No automatic retry will occur.",
      "error",
    );
  });

  it("force fails before starting when the internal decision tool is excluded", async () => {
    const run = createHarness({ allowDecisionTool: false });
    await run.command().handler("run", run.ctx);
    expect(run.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);

    const force = createHarness({ allowDecisionTool: false });
    await force.command().handler("force", force.ctx);
    expect(force.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    expect(force.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringMatching(/re-enable it or reload/i),
      "error",
    );
  });

  it("fails before run when the public tool is excluded", async () => {
    const harness = createHarness({ allowAgentTool: false });
    await harness.command().handler("run", harness.ctx);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("public request tool"),
      "error",
    );
  });

  it("reports host exclusion while all permission commands still update state", async () => {
    const harness = createHarness({ allowAgentTool: false });
    await harness.command().handler("agent-driven-allow", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow 🗜️ ",
    );
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Execution remains unavailable"),
      "warning",
    );
    await harness
      .command()
      .handler("agent-driven-allow-noconfirm", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: agent-driven-allow-noconfirm 🗜️ ",
    );
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Execution remains unavailable"),
      "warning",
    );
    await harness.command().handler("agent-driven-deny", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Execution remains unavailable"),
      "warning",
    );
  });

  it("renders successful internal metadata without visible lines", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);
    const tool = harness.decisionTool();
    expect(tool.renderCall({}, {}, {}).render(80)).toEqual([]);
    expect(
      tool.renderResult({}, {}, {}, { isError: false }).render(80),
    ).toEqual([]);
    expect(
      tool
        .renderResult(
          {
            content: [
              {
                type: "text",
                text: "The decision call was mixed with another tool.",
              },
            ],
          },
          {},
          {},
          { isError: true },
        )
        .render(80),
    ).toEqual(["The decision call was mixed with another tool."]);
  });

  it("keeps custom renderer lines within the requested width", () => {
    const harness = createHarness();
    const width = 154;
    const longMessage = "x".repeat(width + 5);
    const tool = harness.decisionTool();

    const toolLines = tool
      .renderResult(
        { content: [{ type: "text", text: longMessage }] },
        {},
        {},
        { isError: true },
      )
      .render(width);
    expect(toolLines).toHaveLength(1);
    expect(visibleWidth(toolLines[0]!)).toBe(width);
    expect(toolLines[0]).toContain("x".repeat(width));

    const entryLines = harness
      .entryRenderer()({ data: { message: `${longMessage}\nshort` } }, {}, {})
      .render(width);
    expect(entryLines.map((line: string) => visibleWidth(line))).toEqual([
      width,
      5,
    ]);
    expect(entryLines[1]).toBe("short");
  });

  it("does not duplicate active phase progress notifications", async () => {
    const idle = createHarness();
    await idle.command().handler("force", idle.ctx);
    expect(idle.ctx.ui.notify).not.toHaveBeenCalledWith(
      "Recording continuation decision.",
      "info",
    );

    const prepared = createHarness();
    await beginPreparation(prepared);
    await confirmPreparation(prepared);
    expect(prepared.ctx.ui.notify).not.toHaveBeenCalledWith(
      "Creating super-summary.",
      "info",
    );

    const idleWithContext = createHarness();
    await idleWithContext
      .command()
      .handler("force preserve the current constraints", idleWithContext.ctx);
    expect(idleWithContext.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Extra instructions: preserve the current constraints",
      "info",
    );
    expect(idleWithContext.ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Recording continuation decision."),
      "info",
    );

    const busy = createHarness({ idle: false });
    await busy.command().handler("force", busy.ctx);
    expect(busy.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Supercompaction queued; finishing the current tool batch first.",
      "info",
    );
  });

  it("restores the default working message before native compaction", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
  });

  it("ignores a delayed summary request after compaction starts", async () => {
    const harness = createHarness();
    const summaryRequest = await beginForceSummary(harness);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    harness.handlers.get("message_end")?.(
      customMessage(summaryRequest),
      harness.ctx,
    );

    expect(harness.ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
  });

  it("restores the exact visible summary and continues after compaction", async () => {
    const harness = createHarness();
    await beginForceSummary(harness, "", "continue");
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

  it("cancels a queued decision workflow after an aborted assistant turn", async () => {
    const harness = createHarness({ idle: false });
    await harness.command().handler("force", harness.ctx);

    harness.handlers.get("message_end")?.(
      assistantMessage("", [], "aborted"),
      harness.ctx,
    );
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Supercompaction was aborted before native compaction began.",
      "warning",
    );
  });

  it("cancels the summary workflow after an aborted assistant turn", async () => {
    const harness = createHarness();
    const summaryRequest = await beginForceSummary(harness);
    harness.handlers.get("message_end")?.(
      assistantMessage("", [], "aborted"),
      harness.ctx,
    );
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.ctx.abort).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Supercompaction was aborted before native compaction began.",
      "warning",
    );
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
    expect(
      harness.handlers.get("context")?.(
        {
          type: "context",
          messages: [customMessage(summaryRequest).message],
        },
        harness.ctx,
      ),
    ).toEqual({ messages: [] });

    harness.handlers.get("message_end")?.(
      assistantMessage("## State\nShould be ignored."),
      harness.ctx,
    );
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
  });

  it.each(["error", "length"])(
    "keeps the summary workflow active after a %s response",
    async (stopReason) => {
      const harness = createHarness();
      const summaryRequest = await beginForceSummary(harness);
      harness.handlers.get("message_end")?.(
        assistantMessage("", [], stopReason),
        harness.ctx,
      );
      harness.handlers.get("agent_settled")?.({}, harness.ctx);

      expect(harness.ctx.abort).not.toHaveBeenCalled();
      expect(harness.ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Supercompact failed"),
        "error",
      );
      expect(
        harness.handlers.get("context")?.(
          {
            type: "context",
            messages: [customMessage(summaryRequest).message],
          },
          harness.ctx,
        ),
      ).toBeUndefined();

      await recordSummaryDecision(harness, "stop");
      harness.handlers.get("agent_settled")?.({}, harness.ctx);
      expect(harness.ctx.compact).toHaveBeenCalledOnce();
    },
  );

  it.each(["error", "length"])(
    "bounds %s correction turns while preserving recovery",
    async (stopReason) => {
      const harness = createHarness();
      await beginForceSummary(harness);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        harness.handlers.get("message_end")?.(
          assistantMessage("", [], stopReason),
          harness.ctx,
        );
        harness.handlers.get("agent_settled")?.({}, harness.ctx);
      }

      expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(3);
      expect(harness.ctx.abort).not.toHaveBeenCalled();
      await recordSummaryDecision(harness, "stop");
      harness.handlers.get("agent_settled")?.({}, harness.ctx);
      expect(harness.ctx.compact).toHaveBeenCalledOnce();
    },
  );

  it("cancels a preparation workflow after an aborted assistant turn", async () => {
    const harness = createHarness();
    await beginPreparation(harness);

    harness.handlers.get("message_end")?.(
      assistantMessage("", [], "aborted"),
      harness.ctx,
    );
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Supercompaction was aborted before native compaction began.",
      "warning",
    );
    await expect(confirmPreparation(harness)).rejects.toThrow(
      /\/supercompact (run|agent-driven-allow|agent-driven-allow-noconfirm|agent-driven-allow-noconfirm-once)/,
    );
  });

  it("keeps requesting an omitted Markdown handoff without failing the workflow", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);

    harness.handlers.get("message_end")?.(assistantMessage(""), harness.ctx);
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(2);

    harness.handlers.get("message_end")?.(assistantMessage(""), harness.ctx);
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(3);

    harness.handlers.get("message_end")?.(assistantMessage(""), harness.ctx);
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(3);
    expect(harness.ctx.abort).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Supercompact failed"),
      "error",
    );

    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
  });

  it("accepts incidental prose around the sole valid decision call", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);
    await beginDecision(harness);
    const response = assistantMessage("Recording continuation-decision logic", [
      { id: "decision-1" },
    ]).message;
    harness.handlers.get("message_end")?.({ message: response }, harness.ctx);
    expect(
      harness.handlers.get("tool_call")?.(
        {
          toolCallId: "decision-1",
          toolName: DECISION_TOOL_NAME,
          input: { continuation: "stop" },
        },
        harness.ctx,
      ),
    ).toBeUndefined();
    await expect(
      executeDecision(harness, "stop", "decision-1"),
    ).resolves.toMatchObject({ terminate: true });
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
  });

  it("keeps invalid decision responses recoverable after bounded automatic attempts", async () => {
    const harness = createHarness();
    await harness.command().handler("force", harness.ctx);
    await beginDecision(harness);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      harness.handlers.get("message_end")?.(
        assistantMessage("prose", [{ id: `invalid-${attempt}` }]),
        harness.ctx,
      );
      harness.handlers.get("agent_settled")?.({}, harness.ctx);
    }

    expect(harness.ctx.abort).not.toHaveBeenCalled();
    harness.handlers.get("message_end")?.(
      assistantMessage("", [
        { id: "decision-recovered", arguments: { continuation: "stop" } },
      ]),
      harness.ctx,
    );
    await executeDecision(harness, "stop", "decision-recovered");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).toContain(DECISION_TOOL_NAME);
  });

  it("blocks all tools while writing the canonical summary", async () => {
    const harness = createHarness();
    await beginForceSummary(harness);
    expect(
      harness.handlers.get("tool_call")?.(
        {
          toolCallId: "decision-1",
          toolName: DECISION_TOOL_NAME,
          input: { continuation: "continue" },
        },
        harness.ctx,
      ),
    ).toEqual({ block: true, reason: expect.stringContaining("Markdown") });
    expect(
      harness.handlers.get("tool_call")?.(
        { toolCallId: "bash-1", toolName: "bash", input: {} },
        harness.ctx,
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("Markdown"),
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

  it("cancels confirmation errors and keeps schemas stable", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    harness.ctx.ui.confirm.mockRejectedValueOnce(new Error("dialog closed"));
    const result = await confirmPreparation(harness);
    expect(result.details.status).toBe("canceled");
    expect(result.content[0].text).toContain("Do not retry automatically");
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
  });

  it("deny revokes authorization while confirmation is open", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const pending = confirmPreparation(harness);
    await harness.command().handler("agent-driven-deny", harness.ctx);
    confirmation.resolve(true);
    const result = await pending;
    expect(result.details.status).toBe("revoked");
    expect(result.content[0].text).toContain(
      "wait for the user to reauthorize",
    );
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.activeTools()).toEqual(initialTools);
  });

  it("rejects an empty exact next action", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    await expect(
      confirmPreparation(harness, { nextAction: "   " }),
    ).rejects.toThrow("Supply one concrete next action");
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
  });
});

describe("durable continuation outcome", () => {
  it.each([
    [
      "continue",
      "Super-summary prepared. After compaction, the agent will continue working.",
    ],
    [
      "stop",
      "Super-summary prepared. After compaction, the agent will wait for further instructions before proceeding.",
    ],
  ] as const)(
    "persists and renders the %s outcome without adding model context",
    async (continuation, expectedMessage) => {
      const harness = createHarness();
      await beginForceSummary(harness, "", continuation);
      await recordSummaryDecision(harness, continuation);
      harness.handlers.get("agent_settled")?.({}, harness.ctx);

      expect(harness.pi.registerEntryRenderer).toHaveBeenCalledOnce();
      expect(harness.pi.registerEntryRenderer).toHaveBeenCalledWith(
        CONTINUATION_OUTCOME_ENTRY_TYPE,
        expect.any(Function),
      );
      expect(harness.pi.appendEntry).toHaveBeenCalledOnce();
      expect(harness.pi.appendEntry).toHaveBeenCalledWith(
        CONTINUATION_OUTCOME_ENTRY_TYPE,
        { continuation, message: expectedMessage },
      );
      expect(
        harness
          .entryRenderer()(
            { data: { continuation, message: expectedMessage } },
            {},
            {},
          )
          .render(200),
      ).toEqual([expectedMessage]);
      expect(harness.ctx.ui.notify).not.toHaveBeenCalledWith(
        expectedMessage,
        "info",
      );
      expect(harness.messages(CONTINUATION_OUTCOME_ENTRY_TYPE)).toHaveLength(0);
    },
  );
});

describe("summary helper contracts", () => {
  it("preserves preparation intent and exact continuation guidance", () => {
    const prompt = buildSummaryPrompt(
      "",
      {
        expectedContinuation: "continue",
        nextAction: "Implement the next stage.",
        runExtraContext: "preserve constraints",
        agentExtraContext: "include verification",
      },
      false,
      "continue",
    );
    expect(prompt).toContain("Expected continuation: continue");
    expect(prompt).toContain("Exact next action: Implement the next stage.");
    expect(prompt).toContain("preserve constraints");
    expect(prompt).toContain("include verification");
    expect(prompt).toContain("Recorded continuation decision: continue");
    expect(prompt).not.toContain(DECISION_TOOL_NAME);
    expect(prompt).toContain("ordinary Markdown with no wrapper");

    const decisionPrompt = buildDecisionPrompt({
      expectedContinuation: "continue",
      nextAction: "Implement the next stage.",
    });
    expect(decisionPrompt).toContain(DECISION_TOOL_NAME);
    expect(decisionPrompt).toContain("decision-only");

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

  it("normalizes agent confirmation previews and truncates only after ten words", () => {
    expect(
      previewConfirmationValue(
        "  one\ttwo three\nfour five six seven eight nine ten  ",
      ),
    ).toBe("one two three four five six seven eight nine ten");
    expect(
      previewConfirmationValue(
        "one two three four five six seven eight nine ten eleven",
      ),
    ).toBe("one two three four five six seven eight nine ten…");
    expect(
      buildConfirmationText({
        expectedContinuation: "continue",
        nextAction: "Wait for the user.",
      }).split("\n\n"),
    ).toEqual([
      "Post-compaction behavior: continue authorized work",
      "Next action: Wait for the user.",
      "Confirming will begin the canonical super-summary and native compaction immediately.",
    ]);
  });

  it("restores every full preparation value after run authorization", async () => {
    const runExtraContext =
      "one two three four five six seven eight nine ten eleven twelve";
    const nextAction =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const agentExtraContext =
      "red orange yellow green blue indigo violet black white gray silver gold";
    const harness = createHarness();
    await beginPreparedSummary(harness, {
      runContext: runExtraContext,
      params: { nextAction, extraContext: agentExtraContext },
    });
    await recordSummaryDecision(harness, "continue");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    harness.ctx.compact.mock.calls[0][0].onComplete({});

    const restoredMessage = harness.messages(CONTEXT_MESSAGE_TYPE)[0];
    expect(restoredMessage.details.preparation).toEqual({
      authorization: "prepared-no-confirm",
      expectedContinuation: "continue",
      nextAction,
      runExtraContext,
      agentExtraContext,
    });
    expect(restoredMessage.content).toContain(nextAction);
    expect(restoredMessage.content).toContain(runExtraContext);
    expect(restoredMessage.content).toContain(agentExtraContext);
  });

  it("keeps permanent prompts and tool descriptions evergreen", () => {
    const harness = createHarness();
    const preparation = buildPreparationPrompt("context");
    const summary = buildSummaryPrompt("context");
    const continuation = buildContinuationMessage({
      action: "continue",
      summary: "## Next action\nContinue authorized work.",
    });
    const descriptions = harness
      .registeredTools()
      .map((tool) => tool.description)
      .join("\n");
    const permanentText = [
      preparation,
      summary,
      continuation,
      descriptions,
    ].join("\n");

    expect(permanentText).not.toMatch(
      /n-skill|private workflow|personal workflow/i,
    );
    expect(permanentText).not.toMatch(/migration|formerly|superseded/i);
    expect(preparation).not.toContain("actual scoped repository state");
    expect(preparation).not.toContain("observe repository commit rules");
    expect(preparation).toContain("Refresh relevant context");
    expect(preparation).toContain("Correct scoped staleness");
    expect(preparation).toContain("already authorized");
    expect(preparation).toContain("blockers");
    expect(preparation).toContain("Verify or persist");
    expect(preparation).toContain("one exact immediate next action");
    expect(summary).toContain("Relevant resources by work horizon");
    expect(summary).toContain("include exact file paths when files materially");
    expect(descriptions).toContain("availability does not imply authorization");
    expect(descriptions).toContain(
      "Availability alone is never an instruction",
    );
  });
});

describe("stable-schema runtime gates", () => {
  it("registers each tool once and never changes active tools", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    expect(harness.pi.registerTool).toHaveBeenCalledTimes(2);
    expect(harness.registeredTools().map((tool) => tool.name)).toEqual([
      DECISION_TOOL_NAME,
      AGENT_TOOL_NAME,
    ]);

    await beginPreparation(harness);
    await harness.command().handler("agent-driven-deny", harness.ctx);
    await harness.command().handler("agent-driven-allow", harness.ctx);
    harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);
    harness.handlers.get("session_shutdown")?.({}, harness.ctx);

    expect(harness.activeTools()).toEqual(initialTools);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("silently ignores internal calls outside the decision phase", async () => {
    const expected = { content: [], details: { ignored: true } };

    const absent = createHarness();
    await expect(executeDecision(absent, "stop")).resolves.toEqual(expected);
    expect(absent.ctx.abort).not.toHaveBeenCalled();
    expect(absent.ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("decision"),
      "error",
    );

    const queued = createHarness();
    await queued.command().handler("force", queued.ctx);
    await expect(executeDecision(queued, "stop")).resolves.toEqual(expected);
    await expect(executeDecision(queued, "stop", "ignored-2")).resolves.toEqual(
      expected,
    );
    expect(queued.ctx.abort).not.toHaveBeenCalled();
    expect(queued.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);

    const advanced = createHarness();
    await beginForceSummary(advanced);
    await expect(
      executeDecision(advanced, "stop", "decision-2"),
    ).resolves.toEqual(expected);
    expect(advanced.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);

    const awaiting = createHarness();
    await awaiting.command().handler("force", awaiting.ctx);
    await beginDecision(awaiting);
    await expect(executeDecision(awaiting, "stop")).rejects.toThrow(
      "decision-only response",
    );
  });

  it("does not require the internal decision tool for prepared confirmation", async () => {
    const harness = createHarness();
    await harness.command().handler("agent-driven-allow", harness.ctx);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const pending = confirmPreparation(harness);
    harness.excludeTool(DECISION_TOOL_NAME);
    confirmation.resolve(true);

    await expect(pending).resolves.toMatchObject({
      details: { status: "queued" },
    });
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });
});

describe("automatic supercompact", () => {
  const automaticConfig = JSON.stringify({
    supercompact: {
      enabled: true,
      thresholdPercent: 80,
      forceThresholdPercent: 90,
    },
  });

  it("registers both process flags and defaults enabled policy thresholds", () => {
    const harness = createHarness({
      globalConfig: '{"supercompact":{"enabled":true}}',
    });
    expect(harness.pi.registerFlag).toHaveBeenCalledWith("supercompact-auto", {
      type: "boolean",
      description: expect.stringContaining("Enable automatic"),
    });
    expect(harness.pi.registerFlag).toHaveBeenCalledWith(
      "no-supercompact-auto",
      {
        type: "boolean",
        description: expect.stringContaining("Disable automatic"),
      },
    );
    harness.setContextUsage({ tokens: 80, contextWindow: 100, percent: 80 });
    harness.triggerTurnEnd();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("uses force directly at the force threshold and never opens a dialog", () => {
    const harness = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
    });
    harness.triggerTurnEnd();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(DECISION_REQUEST_TYPE)[0].content).toContain(
      "Automatic supercompact reached its force threshold",
    );
    expect(harness.messages(DECISION_REQUEST_TYPE)[0].content).toContain(
      "Choose continue only for clearly unfinished authorized work",
    );
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("prepares once at the soft threshold and bypasses confirmation", async () => {
    const harness = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
    });
    harness.triggerTurnEnd();
    harness.triggerTurnEnd();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)[0].content).toContain(
      "Automatic supercompact authorization is already active",
    );
    expect(harness.messages(PREPARATION_REQUEST_TYPE)[0].content).toContain(
      "Preserve momentum: choose continue when authorized work is clearly unfinished",
    );

    const result = await harness
      .agentTool()
      .execute(
        "automatic-request",
        publicParams(),
        undefined,
        undefined,
        harness.ctx,
      );
    expect(result.details.authorization).toBe("automatic-no-confirm");
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("escalates only automatic preparation and does not duplicate force", () => {
    const harness = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
    });
    harness.triggerTurnEnd();
    harness.setContextUsage({ tokens: 90, contextWindow: 100, percent: 90 });
    harness.triggerTurnEnd();
    harness.triggerTurnEnd();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
    expect(harness.messages(DECISION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("rearms only below the soft threshold or after compaction", () => {
    const harness = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
    });
    harness.triggerTurnEnd();
    harness.handlers.get("session_compact")?.({}, harness.ctx);
    harness.triggerTurnEnd();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(2);

    const below = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
    });
    below.triggerTurnEnd();
    below.command().handler("abort", below.ctx);
    below.setContextUsage({ tokens: 79, contextWindow: 100, percent: 79 });
    below.triggerTurnEnd();
    below.setContextUsage({ tokens: 80, contextWindow: 100, percent: 80 });
    below.triggerTurnEnd();
    expect(below.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(2);
  });

  it("honors flag and session-command precedence and ignores unknown usage", async () => {
    const disabledByFlag = createHarness({
      globalConfig: automaticConfig,
      flags: { "no-supercompact-auto": true },
      contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
    });
    disabledByFlag.triggerTurnEnd();
    expect(disabledByFlag.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);

    const disabledBySession = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
    });
    await disabledBySession
      .command()
      .handler("auto-disable", disabledBySession.ctx);
    disabledBySession.triggerTurnEnd();
    expect(disabledBySession.messages(DECISION_REQUEST_TYPE)).toHaveLength(0);
    expect(disabledBySession.pi.appendEntry).toHaveBeenCalledWith(
      SESSION_AUTOMATIC_ENTRY_TYPE,
      { enabled: false },
    );

    const enabledBySession = createHarness({
      flags: { "no-supercompact-auto": true },
      contextUsage: undefined,
    });
    await enabledBySession
      .command()
      .handler("auto-enable", enabledBySession.ctx);
    enabledBySession.setContextUsage({
      tokens: null,
      contextWindow: 100,
      percent: null,
    });
    enabledBySession.triggerTurnEnd();
    expect(enabledBySession.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    enabledBySession.setContextUsage({
      tokens: 80,
      contextWindow: 100,
      percent: 80,
    });
    enabledBySession.triggerTurnEnd();
    expect(enabledBySession.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
    expect(enabledBySession.pi.appendEntry).toHaveBeenCalledWith(
      SESSION_AUTOMATIC_ENTRY_TYPE,
      { enabled: true },
    );
  });

  it("preserves live automatic overrides across reload and clears them otherwise", async () => {
    const harness = createHarness();
    await harness.command().handler("auto-enable", harness.ctx);
    harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);
    harness.setContextUsage({ tokens: 80, contextWindow: 100, percent: 80 });
    harness.triggerTurnEnd();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);

    harness.handlers.get("session_start")?.({ reason: "resume" }, harness.ctx);
    harness.handlers.get("session_compact")?.({}, harness.ctx);
    harness.triggerTurnEnd();
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("does not supersede explicit preparation at the force threshold", async () => {
    const harness = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
    });
    await beginPreparation(harness);
    harness.triggerTurnEnd();
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(1);
  });

  it("keeps automatic work independent from agent-request denial", async () => {
    const harness = createHarness({
      globalConfig: automaticConfig,
      contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
    });
    harness.triggerTurnEnd();
    await harness.command().handler("agent-driven-deny", harness.ctx);
    const result = await harness
      .agentTool()
      .execute(
        "automatic-request",
        publicParams(),
        undefined,
        undefined,
        harness.ctx,
      );
    expect(result.details.authorization).toBe("automatic-no-confirm");
  });

  it("fails closed for invalid automatic configuration", () => {
    for (const supercompact of [
      true,
      { enabled: "yes" },
      { enabled: true, thresholdPercent: 90, forceThresholdPercent: 80 },
      { enabled: true, thresholdPercent: 0 },
      { enabled: true, forceThresholdPercent: Number.POSITIVE_INFINITY },
    ]) {
      const harness = createHarness({
        globalConfig: JSON.stringify({ supercompact }),
        contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
      });
      harness.triggerTurnEnd();
      expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
      expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring invalid supercompact config"),
        "warning",
      );
    }
  });
});
