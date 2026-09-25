const crypto = require("crypto");
const service = require("./official-account");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function verifyDispatch(secret, headers, body, now = Date.now()) {
  const timestamp = String(headers["x-dispatch-timestamp"] || "");
  const nonce = String(headers["x-dispatch-nonce"] || "");
  const signature = String(headers["x-dispatch-signature"] || "");
  if (!secret || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > 300000) return false;
  const expected = Buffer.from(
    crypto.createHmac("sha256", secret).update(`${timestamp}\n${nonce}\n${sha256(body)}`).digest("hex"),
    "hex",
  );
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function templatePayload(task, env) {
  const order = task.order;
  const project = [order.hotelNameSnapshot, order.roomNameSnapshot].filter(Boolean).join("·").slice(0, 20);
  const date = new Date(order.checkInDate);
  const time = Number.isNaN(date.getTime())
    ? ""
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} 12:00`;
  if (!project || !time || env.OFFICIAL_ACCOUNT_CONST_PENDING !== "待确认接单") {
    throw Error("TEMPLATE_DATA_INVALID");
  }
  return {
    template_id: env.OFFICIAL_ACCOUNT_TEMPLATE_NEW_BOOKING,
    miniprogram: {
      appid: env.MINIPROGRAM_APPID,
      pagepath: `pages/merchant-order-detail/merchant-order-detail?accountId=${encodeURIComponent(task.merchantAccountId)}&id=${encodeURIComponent(order._id)}`,
    },
    data: {
      thing1: { value: `${order.petType || "携宠"}${order.petCount ? ` × ${order.petCount}` : ""}`.slice(0, 20) },
      thing2: { value: project },
      time3: { value: time },
      const4: { value: "待确认接单" },
    },
  };
}

function register(app, { env = process.env, request } = {}) {
  const cache = new service.AccessTokenCache({
    appId: env.OFFICIAL_ACCOUNT_APPID,
    appSecret: env.OFFICIAL_ACCOUNT_APPSECRET,
    request,
  });
  const dispatchNonces = new Map();

  app.post("/api/merchant-binding-qr", async (req, res) => {
    try {
      const token = String(req.body && req.body.token || "");
      if (!req.headers["x-wx-source"] || !/^[A-Za-z0-9_-]{40,80}$/.test(token)) {
        return res.status(403).send({ ok: false });
      }
      return res.send({ ok: true, ...await service.createBindingQr({ token, cache, request }) });
    } catch (error) {
      return res.status(503).send({ ok: false, code: error.code || error.message });
    }
  });

  app.post("/internal/official-notifications/dispatch", async (req, res) => {
    const raw = JSON.stringify(req.body || {});
    const nonce = String(req.headers["x-dispatch-nonce"] || "");
    const now = Date.now();
    for (const [key, value] of dispatchNonces) {
      if (now - value > 300000) dispatchNonces.delete(key);
    }
    if (!verifyDispatch(env.OFFICIAL_NOTIFICATION_DISPATCH_SECRET, req.headers, raw)
        || dispatchNonces.has(nonce)) {
      return res.status(401).send({ ok: false });
    }
    dispatchNonces.set(nonce, now);
    const ids = [...new Set(Array.isArray(req.body.notificationIds) ? req.body.notificationIds : [])]
      .filter((value) => typeof value === "string")
      .slice(0, 20);
    res.send({ ok: true, accepted: ids.length });
    for (const notificationId of ids) {
      let task;
      try {
        task = await service.callBridge({
          url: env.MERCHANT_BINDING_BRIDGE_URL,
          secret: env.MERCHANT_BINDING_BRIDGE_SECRET,
          action: "claimNotification",
          input: { notificationId },
          request,
        });
        await service.sendTemplate({
          openid: task.officialOpenId,
          payload: templatePayload(task, env),
          cache,
          request,
        });
        await service.callBridge({
          url: env.MERCHANT_BINDING_BRIDGE_URL,
          secret: env.MERCHANT_BINDING_BRIDGE_SECRET,
          action: "completeNotification",
          input: { notificationId, claimId: task.claimId, result: "sent" },
          request,
        });
      } catch (error) {
        if (task) {
          service.callBridge({
            url: env.MERCHANT_BINDING_BRIDGE_URL,
            secret: env.MERCHANT_BINDING_BRIDGE_SECRET,
            action: "completeNotification",
            input: {
              notificationId,
              claimId: task.claimId,
              result: "failed",
              errorCode: String(error.code || "SEND_FAILED"),
            },
            request,
          }).catch(() => {});
        }
        console.error("服务号通知发送失败", String(error.code || "UNKNOWN").slice(0, 80));
      }
    }
    return undefined;
  });

  app.post("/", async (req, res, next) => {
    try {
      await service.handleWechatEvent({
        body: req.body,
        bridgeUrl: env.MERCHANT_BINDING_BRIDGE_URL,
        bridgeSecret: env.MERCHANT_BINDING_BRIDGE_SECRET,
        request,
      });
    } catch (error) {
      console.error("公众号事件处理失败", String(error.code || "UNKNOWN").slice(0, 80));
    }
    return next();
  });
}

module.exports = { register, verifyDispatch, templatePayload };
