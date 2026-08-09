// netlify/functions/line-webhook.js
//
// Lets people type a transaction straight into a LINE chat with the school's
// LINE Official Account, e.g.  "รับ 500 ขายน้ำ"  or  "จ่าย 320 ซื้อสมุด"
// and have it saved to Supabase automatically, with a reply confirming it.
//
// Requires a separate "Messaging API" channel in LINE Developers Console,
// created under the SAME Provider as the LIFF (LINE Login) channel — that's
// what makes the LINE userId here match the userId the LIFF app already
// knows, so a person's chat messages and their LIFF profile are the same
// "user" row in Supabase.
//
// Set these on Netlify: Site configuration > Environment variables
//   LINE_CHANNEL_SECRET        = Messaging API channel > Basic settings > Channel secret
//   LINE_CHANNEL_ACCESS_TOKEN  = Messaging API channel > Messaging API > Channel access token (issue one)
//   SUPABASE_URL               = same as in index.html
//   SUPABASE_SERVICE_ROLE_KEY  = Supabase > Project Settings > API > service_role secret key
//                                 (server-side only — never put this in index.html)

const crypto = require("crypto");

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sbHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

function todayBangkok() {
  // Netlify functions run in UTC; Thailand has no DST, so a flat +7h offset is safe.
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function fmtBaht(n) {
  return Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Accepts: "รับ 500 ขายน้ำ" / "รายรับ 500 ขายน้ำ" / "+500 ขายน้ำ"
//          "จ่าย 320 ซื้อสมุด" / "รายจ่าย 320 ซื้อสมุด" / "-320 ซื้อสมุด"
function parseMessage(text) {
  const t = text.trim();
  let m = t.match(/^(?:รายรับ|รับ|\+)\s*([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
  if (m) return { type: "income", amount: parseFloat(m[1]), description: m[2].trim() };
  m = t.match(/^(?:รายจ่าย|จ่าย|-)\s*([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
  if (m) return { type: "expense", amount: parseFloat(m[1]), description: m[2].trim() };
  return null;
}

async function lineReply(replyToken, text) {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    });
  } catch (e) {
    console.error("LINE reply failed", e);
  }
}

async function getOrCreateUser(userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=*`, { headers: sbHeaders });
  const rows = await res.json();
  if (rows[0]) return rows[0];

  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/users?select=id`, {
    headers: { ...sbHeaders, Prefer: "count=exact" },
  });
  const countHeader = countRes.headers.get("content-range"); // "0-0/3"
  const total = countHeader ? parseInt(countHeader.split("/")[1], 10) : 0;
  const role = total === 0 ? "admin" : "viewer";

  const insRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ id: userId, role }),
  });
  const created = await insRes.json();
  return created[0];
}

async function findCategoryId(type, description) {
  if (!description) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/categories?type=eq.${type}&select=id,name`, { headers: sbHeaders });
  const cats = await res.json();
  const hit = (cats || []).find((c) => description.includes(c.name));
  return hit ? hit.id : null;
}

async function handleTextMessage(userId, replyToken, text) {
  const parsed = parseMessage(text);
  if (!parsed) {
    await lineReply(
      replyToken,
      'พิมพ์รูปแบบนี้นะครับ:\n"รับ 500 ขายน้ำ" (บันทึกรายรับ)\n"จ่าย 320 ซื้อสมุด" (บันทึกรายจ่าย)'
    );
    return;
  }

  const user = await getOrCreateUser(userId);
  if (!user || user.role === "viewer") {
    await lineReply(replyToken, "บัญชีของคุณยังเป็นสิทธิ์ \"ดูอย่างเดียว\" กรุณาติดต่อผู้ดูแลระบบให้เพิ่มสิทธิ์ก่อน ถึงจะบันทึกรายการผ่านแชทได้ครับ");
    return;
  }

  const category_id = await findCategoryId(parsed.type, parsed.description);

  const insRes = await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify({
      date: todayBangkok(),
      type: parsed.type,
      category_id,
      description: parsed.description || null,
      amount: parsed.amount,
      created_by: userId,
    }),
  });

  if (!insRes.ok) {
    const err = await insRes.json().catch(() => ({}));
    await lineReply(replyToken, "บันทึกไม่สำเร็จ: " + (err.message || "ลองใหม่อีกครั้ง"));
    return;
  }

  const label = parsed.type === "income" ? "รายรับ" : "รายจ่าย";
  await lineReply(
    replyToken,
    `✅ บันทึก${label} ${fmtBaht(parsed.amount)} บาท${parsed.description ? " (" + parsed.description + ")" : ""} เรียบร้อยครับ`
  );
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing required environment variables");
    return { statusCode: 200, body: "ok" }; // still 200 so LINE doesn't keep retrying
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body || "";

  // Verify the request really came from LINE
  const signature = event.headers["x-line-signature"] || event.headers["X-Line-Signature"];
  const expected = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET).update(rawBody).digest("base64");
  if (signature !== expected) {
    return { statusCode: 401, body: "invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 200, body: "ok" };
  }

  const events = payload.events || [];
  await Promise.all(
    events.map(async (ev) => {
      if (ev.type === "message" && ev.message && ev.message.type === "text" && ev.source && ev.source.userId) {
        try {
          await handleTextMessage(ev.source.userId, ev.replyToken, ev.message.text);
        } catch (e) {
          console.error("handleTextMessage failed", e);
        }
      }
    })
  );

  return { statusCode: 200, body: "ok" };
};
