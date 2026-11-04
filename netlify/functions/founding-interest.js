// Netlify Function — Founding Family Access interest requests.
// Emails the owner through Resend. Reports success only if Resend accepted the message,
// so the visitor is never told "sent" when nothing arrived.

const RESEND_KEY = process.env.RESEND_API_KEY || "";
const OWNER = "hearseedo.english@gmail.com";
const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n) : "");

// Soft per-instance throttle; a determined bot is stopped by the honeypot and size limits instead.
const seen = new Map();
const tooFast = (ip) => {
  const now = Date.now();
  const hits = (seen.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  hits.push(now);
  seen.set(ip, hits);
  if (seen.size > 500) seen.clear();
  return hits.length > 5;
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "method" });
  if ((event.body || "").length > 4000) return reply(413, { ok: false, error: "too_large" });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { ok: false, error: "bad_request" }); }

  // Honeypot: real visitors never fill this. Pretend success so bots learn nothing.
  if (clean(b.website, 50)) return reply(200, { ok: true });

  const name = clean(b.name, 100);
  const email = clean(b.email, 200);
  const note = clean(b.note, 600);
  const lang = b.lang === "jp" ? "jp" : "en";
  if (!name) return reply(400, { ok: false, error: "name" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return reply(400, { ok: false, error: "email" });

  const ip = (event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"])) || "unknown";
  if (tooFast(ip)) return reply(429, { ok: false, error: "rate" });

  if (!RESEND_KEY) return reply(503, { ok: false, error: "not_configured" });

  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Tokyo" });
  const html = `<div style="font-family:sans-serif;max-width:560px;line-height:1.6">
    <p><strong>Founding Family Access request</strong></p>
    <p><strong>Name:</strong> ${esc(name)}<br><strong>Email:</strong> ${esc(email)}<br>
    <strong>Language:</strong> ${lang === "jp" ? "Japanese" : "English"}<br><strong>Time:</strong> ${when} JST</p>
    ${note ? `<p><strong>Their note:</strong><br>${esc(note).replace(/\n/g, "<br>")}</p>` : ""}
    <p style="color:#666;font-size:13px">Reply to this email to reach them. Nothing has been granted: confirm the invitation in the admin console.</p></div>`;

  let r;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "HSDOS.AI Founding <survey@hsdos.ai>",
        to: [OWNER],
        reply_to: email,
        subject: `Founding Family Access request — ${name}`,
        html,
      }),
    });
  } catch (e) {
    console.error("Resend unreachable:", e.message);
    return reply(502, { ok: false, error: "send_failed" });
  }
  if (!r.ok) {
    console.error("Resend refused:", r.status);
    return reply(502, { ok: false, error: "send_failed" });
  }
  return reply(200, { ok: true });
};
