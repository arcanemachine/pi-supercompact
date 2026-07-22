import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  buildConfirmationText,
  buildContinuationMessage,
  buildPreparationPrompt,
  buildSummaryPrompt,
  previewConfirmationValue,
} from "../src/index.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

const readFileSyncMock = vi.mocked(readFileSync);

type Handler = (event: any, ctx: any) => any;

const PREPARATION_REQUEST_TYPE = "pi-supercompact:preparation-request";
const SUMMARY_REQUEST_TYPE = "pi-supercompact:summary-request";
const CONTEXT_MESSAGE_TYPE = "pi-supercompact:context";
const CONTINUATION_OUTCOME_ENTRY_TYPE = "pi-supercompact:continuation-outcome";
const SESSION_PERMISSION_ENTRY_TYPE = "pi-supercompact:session-permission";
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
    excludeTool: (toolName: string) => {
      activeTools = activeTools.filter((name) => name !== toolName);
    },
    registeredTools: () => [...tools.values()],
    entryRenderer: () => entryRenderer,
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
    expect(harness.command().description).toBe(
      "Prepare or force supercompaction; manage request permission or abort",
    );
    harness.ctx.ui.select.mockResolvedValue(undefined);

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.select).toHaveBeenCalledWith("Supercompact", [
      "Run pre-compaction wrap",
      "Force supercompaction now",
      "Allow agent requests with confirmation for this session",
      "Allow agent requests without confirmation for this session",
      "Deny agent supercompaction requests for this session",
      "Abort active pre-native supercompaction",
      "Cancel",
    ]);
  });

  it("selecting no-confirm in the menu enables the distinct session mode", async () => {
    const harness = createHarness();
    harness.ctx.ui.select.mockResolvedValue(
      "Allow agent requests without confirmation for this session",
    );

    await harness.command().handler("", harness.ctx);

    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: allow-noconfirm 🗜️ ",
    );
    await confirmPreparation(harness);
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

  it("6. completion exposes every supported positional command", () => {
    const harness = createHarness();
    expect(harness.command().getArgumentCompletions("")).toEqual(
      ["run", "force", "allow", "allow-noconfirm", "deny", "abort"].map(
        (value) => ({
          value,
          label: value,
        }),
      ),
    );
  });

  it("7. removed, malformed, and legacy commands report the new usage", async () => {
    const harness = createHarness();
    for (const command of [
      "enable",
      "disable",
      "allow extra",
      "allow-noconfirm extra",
      "deny extra",
      "abort extra",
      "legacy bare context",
    ]) {
      await harness.command().handler(command, harness.ctx);
    }
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Usage: /supercompact [run [extra context] | force [extra context] | allow | allow-noconfirm | deny | abort]",
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
      /\/supercompact run for a prepared one-off request.*\/supercompact allow.*\/supercompact allow-noconfirm/,
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
    await harness.command().handler("allow", harness.ctx);
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
    await harness.command().handler("deny", harness.ctx);
    expect(readFileSyncMock.mock.calls).toHaveLength(reads);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "explicitly denied",
    );
  });

  it("16. non-reload session initialization discards overrides and reapplies config", async () => {
    const harness = createHarness({
      globalConfig: '{"agentRequestsAllowed":true}',
    });
    await harness.command().handler("deny", harness.ctx);
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
    await harness.command().handler("allow", harness.ctx);
    await harness.command().handler("allow", harness.ctx);
    await harness.command().handler("deny", harness.ctx);
    await harness.command().handler("deny", harness.ctx);
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

    await harness.command().handler("deny", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );

    await harness.command().handler("allow-noconfirm", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: allow-noconfirm 🗜️ ",
    );

    await harness.command().handler("deny", harness.ctx);
    await harness.command().handler("allow", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: allow 🗜️ ",
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

  it("uses the global confirmation setting for prepared runs", async () => {
    const noConfirm = createHarness({
      hasUI: false,
      globalConfig:
        '{"requireConfirmation":false,"agentRequestsAllowed":true,"agentRequestsRequireConfirmation":true}',
    });
    await beginPreparation(noConfirm);
    const noConfirmResult = await confirmPreparation(noConfirm);
    expect(noConfirm.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(noConfirmResult.details.authorization).toBe("prepared-no-confirm");

    const confirm = createHarness({
      globalConfig:
        '{"requireConfirmation":true,"agentRequestsAllowed":true,"agentRequestsRequireConfirmation":false}',
    });
    await beginPreparation(confirm);
    await confirmPreparation(confirm);
    expect(confirm.ctx.ui.confirm).toHaveBeenCalledOnce();
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
    await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).toHaveBeenCalledOnce();
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
    await harness.command().handler("allow", harness.ctx);
    harness.handlers.get("session_start")?.({ reason: "resume" }, harness.ctx);
    const result = await confirmPreparation(harness);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details.authorization).toBe("configured-no-confirm");
  });

  it("lets explicit session modes override configured confirmation", async () => {
    const require = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await require.command().handler("allow", require.ctx);
    await confirmPreparation(require);
    expect(require.ctx.ui.confirm).toHaveBeenCalledOnce();

    const waive = createHarness({
      globalConfig: '{"requireConfirmation":true,"agentRequestsAllowed":true}',
    });
    await waive.command().handler("allow-noconfirm", waive.ctx);
    await confirmPreparation(waive);
    expect(waive.ctx.ui.confirm).not.toHaveBeenCalled();

    const preparedWaive = createHarness({
      globalConfig: '{"requireConfirmation":true}',
    });
    await beginPreparation(preparedWaive);
    await preparedWaive.command().handler("allow-noconfirm", preparedWaive.ctx);
    await confirmPreparation(preparedWaive);
    expect(preparedWaive.ctx.ui.confirm).not.toHaveBeenCalled();

    const preparedRequire = createHarness({
      globalConfig: '{"requireConfirmation":false}',
    });
    await beginPreparation(preparedRequire);
    await preparedRequire.command().handler("allow", preparedRequire.ctx);
    await confirmPreparation(preparedRequire);
    expect(preparedRequire.ctx.ui.confirm).toHaveBeenCalledOnce();

    const configuredDenied = createHarness({
      hasUI: false,
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await configuredDenied.command().handler("deny", configuredDenied.ctx);
    await expect(confirmPreparation(configuredDenied)).rejects.toThrow(
      "explicitly denied",
    );
    expect(configuredDenied.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);

    const oneOff = createHarness({
      hasUI: false,
      globalConfig: '{"requireConfirmation":false}',
    });
    await oneOff.command().handler("deny", oneOff.ctx);
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

    await harness.command().handler("allow-noconfirm", harness.ctx);
    const result = await confirmPreparation(harness);

    expect(readFileSyncMock.mock.calls).toHaveLength(reads);
    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(1);
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
      "supercompact: allow-noconfirm 🗜️ ",
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
    await headless.command().handler("allow-noconfirm", headless.ctx);
    await expect(confirmPreparation(headless)).resolves.toMatchObject({
      details: { authorization: "session-no-confirm" },
    });
    expect(headless.ctx.ui.confirm).not.toHaveBeenCalled();

    const empty = createHarness({ hasUI: false });
    await empty.command().handler("allow-noconfirm", empty.ctx);
    await expect(
      confirmPreparation(empty, { nextAction: "   " }),
    ).rejects.toThrow("Supply one concrete next action");

    const busy = createHarness({ hasUI: false });
    await busy.command().handler("allow-noconfirm", busy.ctx);
    await confirmPreparation(busy);
    await expect(confirmPreparation(busy)).rejects.toThrow(
      "already in progress",
    );

    const unavailable = createHarness({
      hasUI: false,
      allowDecisionTool: false,
    });
    await unavailable.command().handler("allow-noconfirm", unavailable.ctx);
    await expect(confirmPreparation(unavailable)).rejects.toThrow(
      "internal decision tool",
    );
  });

  it("keeps normal allow confirmation-required and deny revokes both modes", async () => {
    const allowed = createHarness();
    await allowed.command().handler("allow-noconfirm", allowed.ctx);
    await allowed.command().handler("allow", allowed.ctx);
    await confirmPreparation(allowed);
    expect(allowed.ctx.ui.confirm).toHaveBeenCalledOnce();

    const deniedNoConfirm = createHarness();
    await deniedNoConfirm
      .command()
      .handler("allow-noconfirm", deniedNoConfirm.ctx);
    await deniedNoConfirm.command().handler("deny", deniedNoConfirm.ctx);
    await expect(confirmPreparation(deniedNoConfirm)).rejects.toThrow(
      "explicitly denied",
    );
    expect(deniedNoConfirm.ctx.ui.confirm).not.toHaveBeenCalled();

    const deniedAllowed = createHarness();
    await deniedAllowed.command().handler("allow", deniedAllowed.ctx);
    await deniedAllowed.command().handler("deny", deniedAllowed.ctx);
    await expect(confirmPreparation(deniedAllowed)).rejects.toThrow(
      "explicitly denied",
    );
  });

  it("restores each explicit session mode and its status after reload", async () => {
    const noConfirm = createHarness({
      globalConfig: '{"agentRequestsAllowed":false}',
    });
    await noConfirm.command().handler("allow-noconfirm", noConfirm.ctx);
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
      "supercompact: allow-noconfirm 🗜️ ",
    );

    const allowed = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await allowed.command().handler("allow", allowed.ctx);
    allowed.handlers.get("session_start")?.({ reason: "reload" }, allowed.ctx);
    await confirmPreparation(allowed);
    expect(allowed.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(allowed.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: allow 🗜️ ",
    );

    const denied = createHarness({
      globalConfig: '{"requireConfirmation":false,"agentRequestsAllowed":true}',
    });
    await denied.command().handler("deny", denied.ctx);
    denied.handlers.get("session_start")?.({ reason: "reload" }, denied.ctx);
    await expect(confirmPreparation(denied)).rejects.toThrow(
      "explicitly denied",
    );
    expect(denied.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      undefined,
    );
  });

  it("lets prepared run skip its dialog only while no-confirm is active", async () => {
    const noConfirm = createHarness({ hasUI: false });
    await noConfirm.command().handler("allow-noconfirm", noConfirm.ctx);
    await beginPreparation(noConfirm, "preserve this context");
    await confirmPreparation(noConfirm);
    expect(noConfirm.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(noConfirm.messages(SUMMARY_REQUEST_TYPE)[0].content).toContain(
      "preserve this context",
    );

    const normal = createHarness();
    await normal.command().handler("allow", normal.ctx);
    await beginPreparation(normal);
    await confirmPreparation(normal);
    expect(normal.ctx.ui.confirm).toHaveBeenCalledOnce();
  });

  it("keeps schemas stable through no-confirm settlement and denial", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await harness.command().handler("allow-noconfirm", harness.ctx);
    await confirmPreparation(harness);
    const summary = harness.messages(SUMMARY_REQUEST_TYPE)[0];
    harness.handlers.get("message_end")?.(customMessage(summary), harness.ctx);
    await harness.command().handler("deny", harness.ctx);
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

  it("23. deny cancels an unused preparation grant without changing schemas", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparation(harness);
    await harness.command().handler("deny", harness.ctx);
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
    await beginPreparation(harness);
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
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Pending pre-compaction preparation was canceled.",
      "info",
    );

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
      [
        "Post-compaction behavior: stop and wait",
        "Next action: Wait for the user.",
        "Preparation context: run detail",
        "Additional summary context: summary detail",
        "Confirming will begin the canonical super-summary and native compaction immediately.",
      ].join("\n\n"),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("27a. confirmation truncates display values but preserves canonical values", async () => {
    const runContext =
      "one   two three\nfour five six seven eight nine ten eleven twelve";
    const nextAction =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const extraContext =
      "red orange yellow green blue indigo violet black white gray silver gold";
    const harness = createHarness();
    await beginPreparation(harness, runContext);
    await confirmPreparation(harness, { nextAction, extraContext });

    const dialog = harness.ctx.ui.confirm.mock.calls[0][1];
    expect(dialog).toContain(
      "Next action: alpha beta gamma delta epsilon zeta eta theta iota kappa…",
    );
    expect(dialog).toContain(
      "Preparation context: one two three four five six seven eight nine ten…",
    );
    expect(dialog).toContain(
      "Additional summary context: red orange yellow green blue indigo violet black white gray…",
    );
    expect(dialog.split("\n\n")).toHaveLength(5);
    expect(dialog).not.toContain("\n\n\n");

    const summaryPrompt = harness.messages(SUMMARY_REQUEST_TYPE)[0].content;
    expect(summaryPrompt).toContain(nextAction);
    expect(summaryPrompt).toContain(runContext);
    expect(summaryPrompt).toContain(extraContext);
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

  it("30. declining a prepared one-shot clears its grant without changing schemas", async () => {
    const harness = createHarness({ confirmed: false });
    const initialTools = harness.activeTools();
    await beginPreparation(harness);
    await confirmPreparation(harness);
    expect(harness.activeTools()).toEqual(initialTools);
    await expect(confirmPreparation(harness)).rejects.toThrow("not authorized");
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
      globalConfig: '{"agentRequestsAllowed":true}',
    });
    await expect(confirmPreparation(harness)).rejects.toThrow(
      /requires TUI or RPC confirmation.*\/supercompact force explicitly/,
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

  it("38. force remains usable while agent requests are denied", async () => {
    const harness = createHarness();
    await harness.command().handler("deny", harness.ctx);
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
    await harness.command().handler("allow", harness.ctx);
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
    await beginPreparation(harness);
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
    const queuedMessage = queued.messages(SUMMARY_REQUEST_TYPE)[0];
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
    await expect(executeDecision(active, "stop")).rejects.toThrow(
      "No supercompact summary",
    );
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

  it("45. deny during preparation revokes access without changing schemas", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparation(harness);
    await harness.command().handler("deny", harness.ctx);
    expect(harness.activeTools()).toEqual(initialTools);
    await expect(confirmPreparation(harness)).rejects.toThrow(
      "explicitly denied",
    );
  });

  it("46. deny during active summary revokes future access without corruption", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparedSummary(harness);
    await harness.command().handler("deny", harness.ctx);
    expect(harness.activeTools()).toEqual(initialTools);
    await recordSummaryDecision(harness, "stop");
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();
  });

  it("47. internal decision cleanup leaves both schemas active", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await harness.command().handler("allow", harness.ctx);
    await confirmPreparation(harness);
    const summary = harness.messages(SUMMARY_REQUEST_TYPE)[0];
    harness.handlers.get("message_end")?.(customMessage(summary), harness.ctx);
    await recordSummaryDecision(harness, "stop");
    expect(harness.activeTools()).toEqual(initialTools);
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
    expect(failure.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(failure.activeTools()).toContain(DECISION_TOOL_NAME);
    expect(failure.ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(failure.pi.setActiveTools).not.toHaveBeenCalled();
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

  it("fails before run or force when the internal decision tool is excluded", async () => {
    const run = createHarness({ allowDecisionTool: false });
    await run.command().handler("run", run.ctx);
    expect(run.messages(PREPARATION_REQUEST_TYPE)).toHaveLength(0);
    expect(run.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("internal decision tool"),
      "error",
    );

    const force = createHarness({ allowDecisionTool: false });
    await force.command().handler("force", force.ctx);
    expect(force.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
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
    await harness.command().handler("allow", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: allow 🗜️ ",
    );
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Execution remains unavailable"),
      "warning",
    );
    await harness.command().handler("allow-noconfirm", harness.ctx);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-supercompact",
      "supercompact: allow-noconfirm 🗜️ ",
    );
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Execution remains unavailable"),
      "warning",
    );
    await harness.command().handler("deny", harness.ctx);
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
    expect(tool.renderResult({}, {}, {}, { isError: true }).render(80)).toEqual(
      ["Continuation metadata was invalid; correct it as instructed."],
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
    let boundedResult: any;
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
      boundedResult = harness.handlers.get("tool_result")?.(
        toolResultMessage(`invalid-${attempt}`, { isError: true }),
        harness.ctx,
      );
    }
    expect(boundedResult).toMatchObject({
      isError: true,
      content: [
        {
          text: expect.stringContaining(
            "workflow stopped without starting compaction",
          ),
        },
      ],
    });
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
    expect(harness.activeTools()).toContain(DECISION_TOOL_NAME);
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
    await expect(executeDecision(harness, "continue")).rejects.toThrow(
      "exactly once and do not call any other tool",
    );
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
    expect(harness.activeTools()).toContain(AGENT_TOOL_NAME);
  });

  it("deny revokes authorization while confirmation is open", async () => {
    const harness = createHarness();
    const initialTools = harness.activeTools();
    await beginPreparation(harness);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const pending = confirmPreparation(harness);
    await harness.command().handler("deny", harness.ctx);
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
      await beginForceSummary(harness);
      await recordSummaryDecision(harness, continuation);

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
          .render(80),
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

  it("normalizes confirmation previews and truncates only after ten words", () => {
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

  it("restores every full preparation value after truncated previews", async () => {
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
    await harness.command().handler("deny", harness.ctx);
    await harness.command().handler("allow", harness.ctx);
    harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);
    harness.handlers.get("session_shutdown")?.({}, harness.ctx);

    expect(harness.activeTools()).toEqual(initialTools);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("rejects internal calls with phase-specific guidance", async () => {
    const absent = createHarness();
    await expect(executeDecision(absent, "stop")).rejects.toThrow(
      "hidden canonical-summary prompt",
    );

    const queued = createHarness();
    await queued.command().handler("force", queued.ctx);
    await expect(executeDecision(queued, "stop")).rejects.toThrow(
      "canonical-summary phase has not begun",
    );

    const missingSummary = createHarness();
    await beginForceSummary(missingSummary);
    missingSummary.handlers.get("message_end")?.(
      assistantMessage("", [{ id: "decision-empty" }]),
      missingSummary.ctx,
    );
    await expect(
      executeDecision(missingSummary, "stop", "decision-empty"),
    ).rejects.toThrow("non-empty Markdown handoff");

    const advanced = createHarness();
    await beginForceSummary(advanced);
    await recordSummaryDecision(advanced, "stop");
    await expect(
      executeDecision(advanced, "stop", "decision-2"),
    ).rejects.toThrow("workflow has advanced");
  });

  it("rechecks internal-tool availability after confirmation opens", async () => {
    const harness = createHarness();
    await beginPreparation(harness);
    const confirmation = deferred<boolean>();
    harness.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const pending = confirmPreparation(harness);
    harness.excludeTool(DECISION_TOOL_NAME);
    confirmation.resolve(true);

    await expect(pending).rejects.toThrow("internal decision tool");
    expect(harness.messages(SUMMARY_REQUEST_TYPE)).toHaveLength(0);
    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
  });
});
