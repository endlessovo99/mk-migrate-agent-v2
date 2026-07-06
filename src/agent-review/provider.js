import { buildAgentReviewPrompt } from "./prompt.js";

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

  async review({ sourceDraft, dslDraft }) {
    const config = this.readConfig();
    if (!config.ok) return config;

    if (typeof this.fetchImpl !== "function") {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.network",
        diagnostics: [error("agent.provider.fetch_missing", "fetch is not available in this Node runtime.", "/provider/fetch")]
      });
    }

    const prompt = buildAgentReviewPrompt(sourceDraft, dslDraft);
    const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/responses`;
    const body = {
      model: config.model,
      input: [
        { role: "system", content: prompt.system },
        { role: "user", content: JSON.stringify(prompt.context, null, 2) }
      ],
      text: {
        format: { type: "json_object" }
      }
    };

    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (requestError) {
      return blockedProviderResult({
        ...this.metadata(),
        stage: "agent-review.network",
        diagnostics: [error("agent.provider.network_error", redactSecrets(
          requestError instanceof Error ? requestError.message : String(requestError),
          config.apiKey
        ), "/provider/network")]
      });
    }

    const responseText = await safeReadResponseText(response);
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
      stage: "agent-review.provider",
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
      model
    };
  }
}

export function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string") return responseJson.output_text;
  if (typeof responseJson?.content === "string") return responseJson.content;

  for (const output of responseJson?.output || []) {
    if (typeof output?.text === "string") return output.text;
    if (typeof output?.content === "string") return output.content;
    for (const content of output?.content || []) {
      if (typeof content?.text === "string") return content.text;
      if (typeof content?.content === "string") return content.content;
    }
  }

  const choice = responseJson?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
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

async function safeReadResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
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
