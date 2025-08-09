// @ts-check
import express from "express";
import morgan from "morgan";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import crypto from "crypto";
import axios from "axios";
import qs from "qs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const {
  PORT = 3000,
  NS_CLIENT_ID,
  NS_CLIENT_SECRET,
  NS_REDIRECT_URL,
  NS_API_BASE = "https://api.nuvemshop.com.br",
  NS_API_VERSION = "2025-03",
  NS_USER_AGENT = "GoAffPro Bridge (contact@example.com)",
  NS_SCRIPT_ID,
  GOAFFPRO_ACCESS_TOKEN,
  GOAFFPRO_API_BASE = "https://api.goaffpro.com",
  GOAFFPRO_WEBHOOK_SECRET = "change-me"
} = process.env;

if (!NS_CLIENT_ID || !NS_CLIENT_SECRET || !NS_REDIRECT_URL) {
  console.warn("[warn] Please set NS_CLIENT_ID, NS_CLIENT_SECRET, NS_REDIRECT_URL in .env");
}

app.use(cors());
app.use(morgan("dev"));
app.use("/public", express.static(path.join(__dirname, "..", "public")));

// We need the raw body for webhook signature verification
app.post("/webhooks/nuvemshop", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.header("x-linkedstore-hmac-sha256");
    const calculated = crypto.createHmac("sha256", NS_CLIENT_SECRET).update(req.body).digest("hex");
    const safeEqual = crypto.timingSafeEqual(Buffer.from(signature || "", "utf8"), Buffer.from(calculated, "utf8"));
    if (!safeEqual) {
      return res.status(401).send("invalid signature");
    }
  } catch (e) {
    return res.status(401).send("signature check failed");
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("invalid json");
  }

  const { store_id, event, id } = payload || {};
  console.log("[webhook][nuvemshop]", event, "store:", store_id, "id:", id);

  if (event && event.startsWith("order/")) {
    if (event === "order/paid" || event === "order/created" || event === "order/updated") {
      try {
        const order = await nsGetOrder(store_id, id);
        // Try to find coupon
        const couponCode = (order && order.coupon) ? order.coupon : null;
        const email = order && order.customer ? (order.customer.email || null) : null;
        const total = order ? order.total : null;
        const currency = order ? order.currency : null;

        // Attach UTM custom fields if we have them
        await maybeAttachUtmCustomFields(store_id, order, email);

        // Send to GoAffPro for attribution
        await goaffproSendOrder({
          order_id: order ? order.id : id,
          coupon: couponCode,
          email,
          total,
          currency,
          store_id
        });
      } catch (err) {
        console.error("error processing order webhook", err?.response?.data || err.message);
      }
    }
  }

  res.status(200).json({ ok: true });
});

// Simple JSON body for normal endpoints
app.use(bodyParser.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// OAuth callback
app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("missing code");

  try {
    const tokenRes = await axios.post(
      "https://www.tiendanube.com/apps/authorize/token",
      { client_id: NS_CLIENT_ID, client_secret: NS_CLIENT_SECRET, grant_type: "authorization_code", code },
      { headers: { "Content-Type": "application/json" } }
    );
    const { access_token, user_id, scope } = tokenRes.data;
    console.log("[oauth] store", user_id, "scopes:", scope);

    // In a real app: persist this token by user_id (store_id)
    Tokens.set(String(user_id), access_token);

    // Ensure webhooks, custom fields, and (optionally) script association
    await ensureNuvemshopInstallSetup(user_id);

    res.send("App instalada! Você pode fechar esta janela.");
  } catch (err) {
    console.error("[oauth] token exchange failed", err?.response?.data || err.message);
    res.status(500).send("oauth error");
  }
});

// GoAffPro webhook (we protect with a simple shared secret)
app.post("/webhooks/goaffpro", async (req, res) => {
  const secret = req.query.secret;
  if (secret !== GOAFFPRO_WEBHOOK_SECRET) return res.status(401).send("unauthorized");

  const event = req.header("x-goaffpro-event") || (req.body && req.body.event);
  console.log("[webhook][goaffpro]", event);

  const body = req.body || {};

  // Example: affiliate created
  if (event === "affiliate.created" && body.affiliate) {
    try {
      // Generate a coupon in the connected store(s) with a default rule
      for (const [storeId, token] of Tokens.all()) {
        const code = suggestCouponCode(body.affiliate);
        await nsCreateCoupon(storeId, {
          code,
          type: "percentage",
          value: "10.00",
          max_uses: 0, // unlimited
          combines_with_other_discounts: false
        });

        // Assign coupon to affiliate inside GoAffPro (admin API)
        await goaffproAssignCoupon(body.affiliate.id, code);
      }
    } catch (err) {
      console.error("error on affiliate.created", err?.response?.data || err.message);
    }
  }

  res.json({ ok: true });
});

// Capture UTMs from checkout
const UTM_MEMORY = new Map(); // email -> { utm_source,..., ts }
app.post("/session/utm", (req, res) => {
  const { email, ...utms } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: "missing email" });
  UTM_MEMORY.set(email.toLowerCase(), { ...utms, ts: Date.now() });
  res.json({ ok: true });
});

app.post("/admin/test", async (_req, res) => {
  try {
    // ping both sides
    const anyStore = Tokens.firstKey();
    if (anyStore) {
      await nsGetStore(anyStore);
    }
    if (GOAFFPRO_ACCESS_TOKEN) {
      await axios.get(`${GOAFFPRO_API_BASE}/admin/ping`, {
        headers: { "X-Goaffpro-Access-Token": GOAFFPRO_ACCESS_TOKEN }
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Helpers & API clients ---

// Very simple token holder (per process)
const Tokens = {
  _map: new Map(),
  set: (storeId, token) => Tokens._map.set(String(storeId), token),
  get: (storeId) => Tokens._map.get(String(storeId)),
  all: () => Tokens._map.entries(),
  firstKey: () => Tokens._map.keys().next().value
};

function apiBase(storeId) {
  return `${NS_API_BASE}/${NS_API_VERSION}/${storeId}`;
}

async function nsGetStore(storeId) {
  const token = Tokens.get(storeId);
  const res = await axios.get(`${apiBase(storeId)}/store`, {
    headers: { Authentication: `bearer ${token}`, "User-Agent": NS_USER_AGENT }
  });
  return res.data;
}

async function nsGetOrder(storeId, orderId) {
  const token = Tokens.get(storeId);
  const res = await axios.get(`${apiBase(storeId)}/orders/${orderId}`, {
    headers: { Authentication: `bearer ${token}`, "User-Agent": NS_USER_AGENT }
  });
  return res.data;
}

async function nsCreateCoupon(storeId, payload) {
  const token = Tokens.get(storeId);
  const res = await axios.post(`${apiBase(storeId)}/coupons`, payload, {
    headers: {
      Authentication: `bearer ${token}`,
      "User-Agent": NS_USER_AGENT,
      "Content-Type": "application/json"
    }
  });
  return res.data;
}

async function nsEnsureCustomFields(storeId) {
  const token = Tokens.get(storeId);
  const res = await axios.get(`${apiBase(storeId)}/orders/custom-fields`, {
    headers: { Authentication: `bearer ${token}`, "User-Agent": NS_USER_AGENT }
  });
  const existing = res.data || [];
  const need = [
    { key: "UTM Source", value_type: "text" },
    { key: "UTM Medium", value_type: "text" },
    { key: "UTM Campaign", value_type: "text" },
    { key: "UTM Content", value_type: "text" },
    { key: "UTM Term", value_type: "text" },
    { key: "Affiliate Coupon", value_type: "text" },
    { key: "Affiliate ID", value_type: "text" }
  ];
  const idMap = {};
  for (const n of need) {
    const found = existing.find(cf => cf.name === n.key);
    if (found) {
      idMap[n.key] = found.id;
    } else {
      const created = await axios.post(`${apiBase(storeId)}/orders/custom-fields`, {
        name: n.key, value_type: n.value_type, read_only: false, values: []
      }, {
        headers: {
          Authentication: `bearer ${token}`,
          "User-Agent": NS_USER_AGENT,
          "Content-Type": "application/json"
        }
      });
      idMap[n.key] = created.data.id;
    }
  }
  return idMap;
}

async function nsSetOrderCustomFieldValues(storeId, orderId, idValueList) {
  const token = Tokens.get(storeId);
  await axios.put(`${apiBase(storeId)}/orders/${orderId}/custom-fields/values`, idValueList, {
    headers: {
      Authentication: `bearer ${token}`,
      "User-Agent": NS_USER_AGENT,
      "Content-Type": "application/json"
    }
  });
}

async function ensureNuvemshopInstallSetup(storeId) {
  // Register essential webhooks
  const token = Tokens.get(storeId);
  const registerWebhook = async (event, url) => {
    try {
      await axios.post(`${apiBase(storeId)}/webhooks`, { event, url }, {
        headers: {
          Authentication: `bearer ${token}`,
          "User-Agent": NS_USER_AGENT,
          "Content-Type": "application/json"
        }
      });
      console.log("[webhook] registered", event);
    } catch (e) {
      // ignore 422 already exists, etc.
      console.log("[webhook] register", event, "->", e?.response?.status || e.message);
    }
  };
  await registerWebhook("order/paid", publicUrl("/webhooks/nuvemshop"));
  await registerWebhook("app/uninstalled", publicUrl("/webhooks/nuvemshop"));

  // Ensure custom fields
  await nsEnsureCustomFields(storeId);

  // Associate script if provided
  if (NS_SCRIPT_ID) {
    try {
      await axios.post(`${apiBase(storeId)}/scripts`, {
        script_id: Number(NS_SCRIPT_ID),
        query_params: "{}"
      }, {
        headers: {
          Authentication: `bearer ${token}`,
          "User-Agent": NS_USER_AGENT,
          "Content-Type": "application/json"
        }
      });
      console.log("[script] associated", NS_SCRIPT_ID);
    } catch (e) {
      console.log("[script] association failed", e?.response?.data || e.message);
    }
  }
}

function publicUrl(pathname) {
  // naive: uses NS_REDIRECT_URL origin as base
  try {
    const u = new URL(NS_REDIRECT_URL);
    return `${u.origin}${pathname}`;
  } catch {
    return pathname;
  }
}

function suggestCouponCode(affiliate) {
  const base = (affiliate?.code || affiliate?.name || `AFF${affiliate?.id || ""}`)
    .toString()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return base.slice(0, 20) || `AFF${affiliate?.id || ""}`;
}

async function goaffproAssignCoupon(affiliateId, code) {
  if (!GOAFFPRO_ACCESS_TOKEN) {
    console.warn("[goaffpro] missing access token; skip assign coupon");
    return;
  }
  try {
    await axios.post(`${GOAFFPRO_API_BASE}/admin/affiliates/${affiliateId}/coupons`, {
      code
    }, {
      headers: {
        "X-Goaffpro-Access-Token": GOAFFPRO_ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    });
    console.log("[goaffpro] coupon assigned", affiliateId, code);
  } catch (e) {
    console.error("[goaffpro] assign coupon failed", e?.response?.data || e.message);
  }
}

async function goaffproSendOrder({ order_id, coupon, email, total, currency, store_id }) {
  if (!GOAFFPRO_ACCESS_TOKEN) {
    console.warn("[goaffpro] missing access token; skip send order");
    return;
  }
  const payload = {
    order_id,
    email,
    coupon,
    total,
    currency,
    store_id
  };
  try {
    await axios.post(`${GOAFFPRO_API_BASE}/admin/orders`, payload, {
      headers: {
        "X-Goaffpro-Access-Token": GOAFFPRO_ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    });
    console.log("[goaffpro] order queued", order_id);
  } catch (e) {
    console.error("[goaffpro] send order failed", e?.response?.data || e.message);
  }
}

async function maybeAttachUtmCustomFields(storeId, order, email) {
  if (!email) return;
  const utm = UTM_MEMORY.get(email.toLowerCase());
  if (!utm) return;
  const ids = await nsEnsureCustomFields(storeId);
  const list = [];
  if (utm.utm_source) list.push({ id: ids["UTM Source"], value: utm.utm_source });
  if (utm.utm_medium) list.push({ id: ids["UTM Medium"], value: utm.utm_medium });
  if (utm.utm_campaign) list.push({ id: ids["UTM Campaign"], value: utm.utm_campaign });
  if (utm.utm_content) list.push({ id: ids["UTM Content"], value: utm.utm_content });
  if (utm.utm_term) list.push({ id: ids["UTM Term"], value: utm.utm_term });
  if (order?.coupon) list.push({ id: ids["Affiliate Coupon"], value: order.coupon });
  await nsSetOrderCustomFieldValues(storeId, order.id, list);
}

// Start server
app.listen(Number(PORT), () => {
  console.log(`> server on :${PORT}`);
  console.log("Health:", `http://localhost:${PORT}/health`);
});
