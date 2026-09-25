const crypto = require("crypto");
const https = require("https");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const requestJson = (url, options = {}) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: options.method || "GET",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  }, (res) => {
    let raw = "";
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => {
      try {
        resolve({ status: res.statusCode, data: JSON.parse(raw || "{}") });
      } catch (error) {
        reject(error);
      }
    });
  });
  req.on("error", reject);
  if (options.body) req.write(options.body);
  req.end();
});

class AccessTokenCache {
  constructor({ appId, appSecret, request = requestJson }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.request = request;
    this.value = "";
    this.expiresAt = 0;
    this.pending = null;
  }

  invalidate() {
    this.value = "";
    this.expiresAt = 0;
  }

  async get(now = Date.now()) {
    if (this.value && now < this.expiresAt - 120000) return this.value;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (!this.appId || !this.appSecret) throw Error("OFFICIAL_ACCOUNT_CONFIG_MISSING");
      const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.appId)}&secret=${encodeURIComponent(this.appSecret)}`;
      const response = await this.request(url);
      if (!response.data.access_token) {
        throw Object.assign(Error("WECHAT_TOKEN_FAILED"), { code: response.data.errcode });
      }
      this.value = response.data.access_token;
      this.expiresAt = now + (Number(response.data.expires_in) || 7200) * 1000;
      return this.value;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}

function bridgeHeaders(secret, body, now = Date.now()) {
  const timestamp = String(now);
  const nonce = crypto.randomBytes(18).toString("base64url");
  const canonical = `${timestamp}\n${nonce}\n${sha256(body)}`;
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    "x-bridge-timestamp": timestamp,
    "x-bridge-nonce": nonce,
    "x-bridge-signature": signature,
  };
}

async function callBridge({ url, secret, action, input = {}, request = requestJson }) {
  if (!url || !secret) throw Error("BRIDGE_CONFIG_MISSING");
  const body = JSON.stringify({ action, ...input });
  const response = await request(url, { method: "POST", headers: bridgeHeaders(secret, body), body });
  if (response.status < 200 || response.status >= 300 || response.data.ok !== true) {
    throw Object.assign(Error("BRIDGE_REQUEST_FAILED"), { code: response.data && response.data.code });
  }
  return response.data;
}

const sceneToken = (body) => {
  const event = String(body && body.Event || "").toLowerCase();
  let key = String(body && body.EventKey || "");
  if (event === "subscribe" && key.startsWith("qrscene_")) key = key.slice(8);
  return (event === "subscribe" || event === "scan") && /^bind_[A-Za-z0-9_-]{40,80}$/.test(key)
    ? key.slice(5)
    : "";
};

async function createBindingQr({ token, cache, request = requestJson, expires = 600 }) {
  const access = await cache.get();
  const body = JSON.stringify({
    expire_seconds: expires,
    action_name: "QR_STR_SCENE",
    action_info: { scene: { scene_str: `bind_${token}` } },
  });
  const url = `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${encodeURIComponent(access)}`;
  const response = await request(url, { method: "POST", body });
  if ([40001, 42001].includes(response.data.errcode)) {
    cache.invalidate();
    return createBindingQr({ token, cache, request, expires });
  }
  if (!response.data.ticket) {
    throw Object.assign(Error("WECHAT_QR_FAILED"), { code: response.data.errcode });
  }
  return {
    ticket: response.data.ticket,
    url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(response.data.ticket)}`,
    expiresIn: response.data.expire_seconds,
  };
}

async function sendTemplate({ openid, payload, cache, request = requestJson }) {
  const access = await cache.get();
  const url = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(access)}`;
  const response = await request(url, { method: "POST", body: JSON.stringify({ touser: openid, ...payload }) });
  if ([40001, 42001].includes(response.data.errcode)) {
    cache.invalidate();
    return sendTemplate({ openid, payload, cache, request });
  }
  if (response.data.errcode) {
    throw Object.assign(Error("WECHAT_TEMPLATE_FAILED"), { code: response.data.errcode });
  }
  return response.data;
}

async function handleWechatEvent({ body, bridgeUrl, bridgeSecret, request = requestJson }) {
  const event = String(body && body.Event || "").toLowerCase();
  const officialOpenId = String(body && body.FromUserName || "");
  if (event === "unsubscribe") {
    return callBridge({ url: bridgeUrl, secret: bridgeSecret, action: "unsubscribe", input: { officialOpenId }, request });
  }
  const token = sceneToken(body);
  if (token) {
    return callBridge({ url: bridgeUrl, secret: bridgeSecret, action: "consumeBinding", input: { token, officialOpenId }, request });
  }
  return { ok: true, ignored: true };
}

module.exports = {
  AccessTokenCache,
  bridgeHeaders,
  callBridge,
  sceneToken,
  createBindingQr,
  sendTemplate,
  handleWechatEvent,
};
