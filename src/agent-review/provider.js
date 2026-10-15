import { buildAgentReviewPrompt, buildAgentReviewRepairPrompt } from "./prompt.js";

export class OpenAIResponsesReviewProvider {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  metadata() {
    return {
      provider: "openai",
      baseUrl: this.env.OPENAI_BASE_URL || "",
      model: this.env.OPENAI_MODEL || ""
    };
  }

  async review({ sourceDraft, dslDraft, reviewScope }) {
    return this.submitPrompt(buildAgentReviewPrompt(sourceDraft, dslDraft, { reviewScope, compact: this.env.OPENAI_REVIEW_CONTEXT === "compact" }), "agent-review.provider");
  }

  async repairReviewResponse({ sourceDraft, dslDraft, reviewScope, rawText, diagnostics, rejectedPatches, attempt }) {
    return this.submitPrompt(buildAgentReviewRepairPrompt(sourceDraft, dslDraft, {
      reviewScope,
      compact: this.env.OPENAI_REVIEW_CONTEXT === "compact",
      rawText,
      diagnostics,
      rejectedPatches,
      attempt
    }), "agent-review.provider-repair");
  }

  async submitPrompt(prompt, stage) {
    const config = this.readConfig();
    if (!config.ok) return config;

    if (typeof this.fetchImpl !== "function") {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.network",
        diagnostics: [error("agent.provider.fetch_missing", "fetch is not available in this Node runtime.", "/provider/fetch")]
      });
    }

    const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/responses`;
    const body = {
      model: config.model,
      stream: false,
      input: [
        { role: "system", content: prompt.system },
        { role: "user", content: JSON.stringify(prompt.context, null, 2) }
      ],
      text: {
        format: { type: "json_object" }
      }
    };
    if (config.thinking) body.thinking = { type: config.thinking };

    const transport = await receiveResponseWithinDeadline((signal) => this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    }), config.requestTimeoutMs);
    if (!transport.ok) {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.network",
        diagnostics: [error(
          transport.timedOut ? "agent.provider.request_timeout" : transport.phase === "body" ? "agent.provider.body_read_error" : "agent.provider.network_error",
          transport.timedOut ? `OpenAI Responses request exceeded its ${config.requestTimeoutMs} ms deadline.` : redactSecrets(
            transportErrorMessage(transport.cause), config.apiKey
          ), "/provider/network", {
            phase: transport.phase,
            ...(transport.timedOut ? { timeoutMs: config.requestTimeoutMs } : {})
          }
        )]
      });
    }
    const { response, responseText } = transport;

    if (!response.ok) {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.network",
        diagnostics: [error("agent.provider.http_error", `OpenAI Responses request failed with HTTP ${response.status}.`, "/provider/http", {
          status: response.status,
          responsePreview: preview(responseText, config.apiKey)
        })],
        rawResponsePreview: preview(responseText, config.apiKey)
      });
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.response-parse",
        diagnostics: [error("agent.provider.response_json_invalid", "OpenAI Responses API returned non-JSON response data.", "/provider/response")],
        rawResponsePreview: preview(responseText, config.apiKey)
      });
    }

    const outputText = extractResponseText(responseJson);
    if (!outputText) {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.response-parse",
        diagnostics: [error("agent.provider.output_text_missing", "OpenAI Responses API response did not contain model output text.", "/provider/response/output")],
        rawResponsePreview: preview(responseText, config.apiKey)
      });
    }

    return {
      ok: true,
      status: "received",
      stage,
      ...this.metadata(),
      promptVersion: prompt.promptVersion,
      rawText: redactSecrets(outputText, config.apiKey),
      rawResponsePreview: preview(responseText, config.apiKey)
    };
  }

  readConfig() {
    const baseUrl = this.env.OPENAI_BASE_URL;
    const apiKey = this.env.OPENAI_API_KEY;
    const model = this.env.OPENAI_MODEL;
    const missing = [
      ["OPENAI_BASE_URL", baseUrl],
      ["OPENAI_API_KEY", apiKey],
      ["OPENAI_MODEL", model]
    ].filter(([, value]) => !nonEmptyString(value)).map(([name]) => name);

    if (missing.length) {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.env",
        diagnostics: [error("agent.provider.env_missing", "agent-review requires OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL.", "/provider/env", {
          missing
        })]
      });
    }

    return {
      ok: true,
      baseUrl,
      apiKey,
      model,
      thinking: normalizeThinking(this.env.OPENAI_THINKING),
      requestTimeoutMs: positiveInteger(this.env.OPENAI_REQUEST_TIMEOUT_MS, 600000)
    };
  }
}

function normalizeThinking(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["enabled", "disabled"].includes(normalized) ? normalized : undefined;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string") return responseJson.output_text;
  if (typeof responseJson?.content === "string") return responseJson.content;

  const outputs = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const ordered = [
    ...outputs.filter((output) => output?.type === "message"),
    ...outputs.filter((output) => output?.type !== "message" && output?.type !== "reasoning")
  ];
  for (const output of ordered) {
    const text = textFromOutput(output);
    if (text) return text;
  }

  const choice = responseJson?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

function textFromOutput(output) {
  if (typeof output?.text === "string" && output.text) return output.text;
  if (typeof output?.content === "string" && output.content) return output.content;
  for (const content of output?.content || []) {
    if (content?.type === "reasoning_text") continue;
    if (typeof content?.text === "string" && content.text) return content.text;
    if (typeof content?.content === "string" && content.content) return content.content;
  }
  return "";
}

export function redactSecrets(value, apiKey = "") {
  let text = String(value ?? "");
  if (apiKey) text = text.split(apiKey).join("[REDACTED_OPENAI_API_KEY]");
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED_OPENAI_API_KEY]");
}

function blockedProviderResult(input) {
  return {
    ok: false,
    status: "blocked",
    provider: input.provider || "openai",
    baseUrl: input.baseUrl || "",
    model: input.model || "",
    stage: input.stage,
    diagnostics: input.diagnostics || [],
    rawResponsePreview: input.rawResponsePreview
  };
}

// Bound both headers and complete body consumption. AbortSignal is the transport
// cancellation contract; the deadline also bounds async test/custom transports
// that ignore it. Cleanup is best-effort and must not extend that deadline.
async function receiveResponseWithinDeadline(request, timeoutMs) {
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  const timeoutError = new Error("Provider request deadline exceeded.");
  let response, reader, timer;
  let phase = "headers", timedOut = false, stopped = false;
  const cancelTransport = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (reader) ignoreCleanup(() => reader.cancel());
    else cancelResponseBody(response);
  };
  const checkDeadline = () => {
    if (timedOut || performance.now() >= deadlineAt) {
      timedOut = true;
      throw timeoutError;
    }
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      cancelTransport();
      reject(timeoutError);
    }, timeoutMs);
  });
  const pending = (async () => {
    response = await request(controller.signal);
    if (timedOut || performance.now() >= deadlineAt) {
      timedOut = true;
      if (stopped) cancelResponseBody(response);
      else cancelTransport();
      throw timeoutError;
    }
    phase = "body";
    const responseText = await readResponseText(response, (value) => { reader = value; }, checkDeadline);
    checkDeadline();
    return { response, responseText };
  })();
  try {
    return { ok: true, ...await Promise.race([pending, deadline]) };
  } catch (cause) {
    if (performance.now() >= deadlineAt) timedOut = true;
    cancelTransport();
    return { ok: false, cause, phase, timedOut };
  } finally {
    clearTimeout(timer);
    if (reader) ignoreCleanup(() => reader.releaseLock());
  }
}

async function readResponseText(response, ownReader, checkDeadline) {
  if (typeof response?.body?.getReader !== "function") return response.text();
  const reader = response.body.getReader();
  ownReader(reader);
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    checkDeadline();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

function cancelResponseBody(response) {
  ignoreCleanup(() => response?.body?.cancel?.());
}

function ignoreCleanup(callback) {
  try { Promise.resolve(callback()).catch(() => {}); } catch {}
}

function transportErrorMessage(cause) {
  try { return cause instanceof Error ? cause.message : String(cause); }
  catch { return "Provider response transport failed."; }
}

function preview(value, apiKey) {
  const text = redactSecrets(value, apiKey);
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function error(code, message, path, details) {
  return { level: "error", code, message, path, details };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
