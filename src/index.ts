import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SUMMARY_REQUEST_TYPE = "pi-supercompact:summary-request";
const CONTEXT_MESSAGE_TYPE = "pi-supercompact:context";
const SUMMARY_PLACEHOLDER = "Super-summary prepared; compacting context.";

export type ContinuationAction = "continue" | "stop";

export interface ParsedSuperSummary {
  action: ContinuationAction;
  summary: string;
}

type RequestPhase =
  | "queued"
  | "awaiting-summary"
  | "summary-ready"
  | "compacting";

interface SupercompactRequest extends ParsedSuperSummary {
  id: string;
  phase: RequestPhase;
  extraContext: string;
  compactionCompleted: boolean;
  parseError?: string;
}

interface SummaryRequestDetails {
  requestId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function textFromAssistant(message: { content: unknown }): string {
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function hasToolCalls(message: { content: unknown }): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((part) => isRecord(part) && part.type === "toolCall")
  );
}

function stripCodeFence(value: string): string {
  const match = value.match(/^```(?:xml)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : value;
}

export function parseSuperSummary(
  value: string,
): ParsedSuperSummary | undefined {
  const normalized = stripCodeFence(value.trim());
  const match = normalized.match(
    /^<supercompact continuation="(continue|stop)">\s*([\s\S]*?)\s*<\/supercompact>$/,
  );
  if (!match || !match[2].trim()) return undefined;

  return {
    action: match[1] as ContinuationAction,
    summary: match[2].trim(),
  };
}

export function buildSummaryPrompt(extraContext: string): string {
  const emphasis = extraContext.trim()
    ? [
        "The user supplied the following extra context. It has highest priority when shaping the summary and continuation decision:",
        "<extra-context>",
        extraContext.trim(),
        "</extra-context>",
      ].join("\n")
    : "The user supplied no extra context.";

  return [
    "Prepare a practical full-context continuation summary before context compaction.",
    "Summarize the entire conversation context currently available to you, including relevant earlier summaries and user-provided state.",
    "Do not call tools, modify files, continue the task, or answer questions from the conversation. Only produce the requested summary.",
    "",
    emphasis,
    "",
    "Include useful sections without forcing empty ones:",
    "- Goal or direction",
    "- Work completed and current state",
    "- Key decisions",
    "- Files, paths, commands, artifacts, or commits",
    "- Verification performed",
    "- In-progress work",
    "- Blockers or risks",
    "- Upcoming items and where to resume",
    "- Continuation cautions and user-decided direction",
    "",
    "Use only known facts. Clearly qualify reported or unverified claims. Prefer compact headings, bullets, and concrete paths. Refer to the user in the third person.",
    "",
    'Choose continuation="continue" when the user explicitly requests continuation or previously authorized work remains actively incomplete and can proceed without new user input.',
    'Choose continuation="stop" when the user explicitly requests stopping, the work is complete, no actionable work remains, or progress requires user input or approval.',
    "Explicit extra context overrides the default continuation decision.",
    "",
    "Reply with exactly this wrapper and no surrounding commentary or code fence:",
    '<supercompact continuation="continue|stop">',
    "[Markdown summary]",
    "</supercompact>",
  ].join("\n");
}

export function buildContinuationMessage(parsed: ParsedSuperSummary): string {
  const directive =
    parsed.action === "continue"
      ? "Continue the previously authorized incomplete work now. Use the summary as authoritative continuation context, do not repeat completed work, and do not merely acknowledge this message."
      : "Do not automatically continue prior work. Preserve this summary as context and wait for the user's next instruction.";

  return [
    "# Supercompaction context",
    "",
    parsed.summary,
    "",
    "## Continuation directive",
    "",
    directive,
  ].join("\n");
}

type ContextMessage = ContextEvent["messages"][number];
type CustomContextMessage = Extract<ContextMessage, { role: "custom" }>;

function isSummaryRequestMessage(
  message: ContextMessage,
): message is CustomContextMessage {
  return (
    message.role === "custom" && message.customType === SUMMARY_REQUEST_TYPE
  );
}

function requestIdFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const requestId = (details as SummaryRequestDetails).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

export default function supercompactExtension(pi: ExtensionAPI): void {
  let request: SupercompactRequest | undefined;

  const fail = (ctx: ExtensionContext, message: string): void => {
    request = undefined;
    notify(ctx, `Supercompact failed: ${message}`, "error");
  };

  const finish = (ctx: ExtensionContext): void => {
    if (!request || request.phase !== "compacting") return;

    const parsed: ParsedSuperSummary = {
      action: request.action,
      summary: request.summary,
    };
    const content = buildContinuationMessage(parsed);
    request = undefined;

    if (parsed.action === "continue") {
      pi.sendMessage(
        {
          customType: CONTEXT_MESSAGE_TYPE,
          content,
          display: true,
          details: { version: 1, continuation: parsed.action },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return;
    }

    pi.sendMessage(
      {
        customType: CONTEXT_MESSAGE_TYPE,
        content,
        display: true,
        details: { version: 1, continuation: parsed.action },
      },
      ctx.isIdle() ? undefined : { deliverAs: "nextTurn" },
    );
  };

  pi.on("session_start", () => {
    request = undefined;
  });

  pi.on("session_shutdown", () => {
    request = undefined;
  });

  pi.on("context", (event) => {
    const activeRequestId =
      request?.phase === "queued" || request?.phase === "awaiting-summary"
        ? request.id
        : undefined;
    const messages = event.messages.filter((message) => {
      if (isSummaryRequestMessage(message)) {
        return requestIdFromDetails(message.details) === activeRequestId;
      }
      if (message.role === "assistant") {
        return textFromAssistant(message) !== SUMMARY_PLACEHOLDER;
      }
      return true;
    });

    return messages.length === event.messages.length ? undefined : { messages };
  });

  pi.on("tool_call", (_event) => {
    if (request?.phase !== "awaiting-summary") return;
    return {
      block: true,
      reason:
        "Tools are disabled while preparing a supercompact summary. Return the required <supercompact> wrapper without calling tools.",
    };
  });

  pi.on("message_end", (event) => {
    if (!request) return;

    if (
      event.message.role === "custom" &&
      event.message.customType === SUMMARY_REQUEST_TYPE &&
      requestIdFromDetails(event.message.details) === request.id
    ) {
      request.phase = "awaiting-summary";
      return;
    }

    if (
      request.phase !== "awaiting-summary" ||
      event.message.role !== "assistant"
    ) {
      return;
    }

    if (hasToolCalls(event.message)) return;

    if (
      event.message.stopReason === "aborted" ||
      event.message.stopReason === "error" ||
      event.message.stopReason === "length"
    ) {
      request.parseError = `summary response ended with ${event.message.stopReason}`;
      return;
    }

    const parsed = parseSuperSummary(textFromAssistant(event.message));
    if (!parsed) {
      request.parseError =
        "summary response did not contain the required wrapper";
      return;
    }

    request.action = parsed.action;
    request.summary = parsed.summary;
    request.phase = "summary-ready";
    request.parseError = undefined;

    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: SUMMARY_PLACEHOLDER }],
      },
    };
  });

  pi.on("session_compact", () => {
    if (request) request.compactionCompleted = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!request) return;

    if (request.phase === "queued" || request.phase === "awaiting-summary") {
      fail(
        ctx,
        request.parseError ??
          "the summary turn settled without a valid summary",
      );
      return;
    }

    if (request.phase !== "summary-ready") return;

    request.phase = "compacting";
    if (request.compactionCompleted) {
      finish(ctx);
      return;
    }

    ctx.compact({
      onComplete: () => finish(ctx),
      onError: (error) => fail(ctx, error.message),
    });
  });

  pi.registerCommand("supercompact", {
    description:
      "Summarize full context, compact normally, and resume if needed",
    handler: async (args, ctx) => {
      if (request) {
        notify(ctx, "Supercompact is already in progress.", "warning");
        return;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      request = {
        id,
        phase: "queued",
        extraContext: args.trim(),
        action: "stop",
        summary: "",
        compactionCompleted: false,
      };

      notify(ctx, "Supercompact queued.");
      pi.sendMessage(
        {
          customType: SUMMARY_REQUEST_TYPE,
          content: buildSummaryPrompt(request.extraContext),
          display: false,
          details: { version: 1, requestId: id },
        },
        ctx.isIdle()
          ? { triggerTurn: true, deliverAs: "steer" }
          : { deliverAs: "steer" },
      );
    },
  });
}
