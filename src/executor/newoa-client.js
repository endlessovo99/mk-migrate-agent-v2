export const NEWOA_SIT_BASE_URL = "https://p-sit.onewo.com";

export class NewoaClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || NEWOA_SIT_BASE_URL);
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.cookie = "";
    this.token = "";
    if (typeof this.fetch !== "function") {
      throw new Error("global fetch is required for NewOA API execution");
    }
  }

  async login({ username, encryptedPassword }) {
    const body = new URLSearchParams({
      j_username: username,
      j_password: encryptedPassword
    });
    const response = await this.fetch(`${this.baseUrl}/data/sys-auth/login`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded",
        origin: this.baseUrl,
        referer: `${this.baseUrl}/web/`,
        "x-accept-language": "zh-CN"
      },
      body
    });
    const result = await readResponse(response);
    this.cookie = collectCookies(response.headers);
    this.token = tokenFromBody(result.body);
    if (!response.ok || result.body?.success === false) {
      const error = new Error(`NewOA login failed: ${result.body?.msg || response.status}`);
      error.stage = "login";
      error.response = result;
      throw error;
    }
    return result.body;
  }

  async addTemplate(payload) {
    const body = await this.postKmReview("kmReviewTemplate/add", payload);
    const template = body?.data || {};
    const fdId = template.fdId || template.id;
    if (!fdId) {
      throw new Error("create template response did not include fdId");
    }
    return {
      ...template,
      fdId
    };
  }

  async getTemplate(fdId) {
    const body = await this.postKmReview("kmReviewTemplate/get", {
      fdId,
      mechanisms: {
        load: "*"
      }
    });
    if (!body?.data?.fdId) {
      throw new Error("template detail response did not include fdId");
    }
    return body.data;
  }

  async updateTemplate(payload) {
    const body = await this.postKmReview("kmReviewTemplate/update", payload);
    return body?.data || { fdId: payload.fdId };
  }

  async postKmReview(apiPath, payload) {
    const response = await this.fetch(`${this.baseUrl}/data/km-review/${apiPath}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify(payload || {})
    });
    const result = await readResponse(response);
    if (!response.ok || result.body?.success === false) {
      const error = new Error(`NewOA API ${apiPath} failed: ${result.body?.msg || response.status}`);
      error.stage = apiPath;
      error.response = result;
      throw error;
    }
    return result.body;
  }
}

export function assertAllowedBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl || NEWOA_SIT_BASE_URL);
  const url = new URL(normalized);
  if (url.origin !== NEWOA_SIT_BASE_URL) {
    throw new Error("NewOA execution is locked to https://p-sit.onewo.com in v2 route-validation.");
  }
  return normalized;
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

async function readResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  return {
    status: response.status,
    body
  };
}

function collectCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  }
  const value = headers.get?.("set-cookie") || "";
  return value
    .split(/,(?=[^;]+?=)/)
    .map((item) => item.split(";", 1)[0].trim())
    .filter(Boolean)
    .join("; ");
}

function tokenFromBody(body) {
  return body?.token ||
    body?.access_token ||
    body?.accessToken ||
    body?.data?.token ||
    body?.data?.access_token ||
    body?.data?.accessToken ||
    "";
}
