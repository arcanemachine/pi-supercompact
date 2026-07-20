import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension, {
  buildContinuationMessage,
  buildSummaryPrompt,
  parseSuperSummary,
} from "../src/index.js";

type Handler = (event: any, ctx: any) => any;

function createHarness(options: { idle?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  let command:
    | { handler: (args: string, ctx: any) => Promise<void> }
    | undefined;
  const pi = {
    on: vi.fn((event: string, handler: Handler) =>
      handlers.set(event, handler),
    ),
    registerCommand: vi.fn((_name: string, value: typeof command) => {
      command = value;
    }),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  extension(pi);

  const ctx = {
    hasUI: true,
    isIdle: vi.fn(() => options.idle ?? true),
    ui: { notify: vi.fn() },
    compact: vi.fn(),
  };

  return {
    pi: pi as any,
    ctx,
    handlers,
    command: () => {
      if (!command) throw new Error("command not registered");
      return command;
    },
  };
}

function summaryRequestFrom(harness: ReturnType<typeof createHarness>) {
  const [message, options] = harness.pi.sendMessage.mock.calls[0];
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

function assistantMessage(text: string, stopReason = "stop") {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
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

describe("summary helpers", () => {
  it("builds a distilled full-context prompt with extra context", () => {
    const prompt = buildSummaryPrompt("stop after compaction");

    expect(prompt).toContain("entire conversation context");
    expect(prompt).toContain("stop after compaction");
    expect(prompt).toContain('<supercompact continuation="continue|stop">');
    expect(prompt).toContain("Do not call tools");
  });

  it("parses continuation wrappers and optional XML fences", () => {
    expect(
      parseSuperSummary(
        '<supercompact continuation="continue">\n## State\nReady.\n</supercompact>',
      ),
    ).toEqual({ action: "continue", summary: "## State\nReady." });

    expect(
      parseSuperSummary(
        '```xml\n<supercompact continuation="stop">\nWait.\n</supercompact>\n```',
      ),
    ).toEqual({ action: "stop", summary: "Wait." });
    expect(parseSuperSummary("ordinary text")).toBeUndefined();
  });

  it("builds action-specific continuation instructions", () => {
    expect(
      buildContinuationMessage({ action: "continue", summary: "Context" }),
    ).toContain("Continue the previously authorized incomplete work now");
    expect(
      buildContinuationMessage({ action: "stop", summary: "Context" }),
    ).toContain("wait for the user's next instruction");
  });
});

describe("supercompact workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues the summary prompt as immediate steering while busy", async () => {
    const harness = createHarness({ idle: false });

    await harness.command().handler("focus on tests", harness.ctx);

    const { message, options } = summaryRequestFrom(harness);
    expect(message.customType).toBe("pi-supercompact:summary-request");
    expect(message.content).toContain("focus on tests");
    expect(message.display).toBe(false);
    expect(options).toEqual({ deliverAs: "steer" });
  });

  it("compacts after capturing a valid summary and then continues", async () => {
    const harness = createHarness();
    await harness.command().handler("", harness.ctx);
    const { message: requestMessage } = summaryRequestFrom(harness);

    harness.handlers.get("message_end")?.(
      customMessage(requestMessage),
      harness.ctx,
    );
    const replacement = harness.handlers.get("message_end")?.(
      assistantMessage(
        '<supercompact continuation="continue">\n## State\nKeep going.\n</supercompact>',
      ),
      harness.ctx,
    );

    expect(replacement.message.content).toEqual([
      { type: "text", text: "## State\nKeep going." },
    ]);
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Super-summary prepared; compacting context.",
      "info",
    );

    harness.handlers.get("agent_settled")?.({}, harness.ctx);
    expect(harness.ctx.compact).toHaveBeenCalledOnce();

    const callbacks = harness.ctx.compact.mock.calls[0][0];
    callbacks.onComplete({});

    const [finalMessage, finalOptions] = harness.pi.sendMessage.mock.calls[1];
    expect(finalMessage.customType).toBe("pi-supercompact:context");
    expect(finalMessage.display).toBe(false);
    expect(finalMessage.content).toContain("## State\nKeep going.");
    expect(finalOptions).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("uses successful native auto-compaction instead of compacting twice", async () => {
    const harness = createHarness();
    await harness.command().handler("", harness.ctx);
    const { message: requestMessage } = summaryRequestFrom(harness);

    harness.handlers.get("message_end")?.(
      customMessage(requestMessage),
      harness.ctx,
    );
    harness.handlers.get("message_end")?.(
      assistantMessage(
        '<supercompact continuation="stop">\n## State\nDone.\n</supercompact>',
      ),
      harness.ctx,
    );
    harness.handlers.get("session_compact")?.({}, harness.ctx);
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.ctx.compact).not.toHaveBeenCalled();
    const [finalMessage, finalOptions] = harness.pi.sendMessage.mock.calls[1];
    expect(finalMessage.content).toContain("## State\nDone.");
    expect(finalMessage.display).toBe(false);
    expect(finalOptions).toBeUndefined();
  });

  it("reports invalid summary output without compacting or injecting", async () => {
    const harness = createHarness();
    await harness.command().handler("", harness.ctx);
    const { message: requestMessage } = summaryRequestFrom(harness);

    harness.handlers.get("message_end")?.(
      customMessage(requestMessage),
      harness.ctx,
    );
    harness.handlers.get("message_end")?.(
      assistantMessage("invalid"),
      harness.ctx,
    );
    harness.handlers.get("agent_settled")?.({}, harness.ctx);

    expect(harness.ctx.compact).not.toHaveBeenCalled();
    expect(harness.pi.sendMessage).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("required wrapper"),
      "error",
    );
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
