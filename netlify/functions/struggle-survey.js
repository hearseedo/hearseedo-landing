// Netlify Function — English struggle survey submissions
// Saves to Firestore + sends notification email via Resend

const PROJECT_ID   = "hear-see-do-os-ai";
const FIREBASE_KEY = process.env.FIREBASE_API_KEY || "";
const RESEND_KEY   = process.env.RESEND_API_KEY   || "";
const FS_BASE      = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: "Bad request" }; }

  const struggles = (body.struggles || []).filter(Boolean).slice(0, 20);
  const other     = (body.other  || "").slice(0, 500).trim();
  const email     = (body.email  || "").slice(0, 200).trim();
  const lang      = body.lang === "jp" ? "jp" : "en";

  if (struggles.length === 0 && !other) {
    return { statusCode: 400, headers, body: "No response provided" };
  }

  const timestamp = new Date().toISOString();

  // Save to Firestore
  if (FIREBASE_KEY) {
    try {
      await fetch(`${FS_BASE}/struggleSurvey?key=${FIREBASE_KEY}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            struggles:   { arrayValue: { values: struggles.map(s => ({ stringValue: s })) } },
            other:       { stringValue: other },
            email:       { stringValue: email },
            lang:        { stringValue: lang },
            source:      { stringValue: "landing_page" },
            submittedAt: { timestampValue: timestamp },
          },
        }),
      });
    } catch (e) {
      console.error("Firestore write failed:", e.message);
    }
  }

  // Send notification email via Resend
  if (RESEND_KEY) {
    const lines = [
      `<strong>Struggles:</strong> ${struggles.join(", ") || "—"}`,
      other  ? `<strong>Their words:</strong> "${other}"` : null,
      email  ? `<strong>Email:</strong> ${email}` : null,
      `<strong>Language:</strong> ${lang === "jp" ? "Japanese UI" : "English UI"}`,
      `<strong>Time:</strong> ${new Date(timestamp).toLocaleString("en-GB", { timeZone: "Asia/Tokyo" })} JST`,
    ].filter(Boolean).join("<br>");

    await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from:    "HSD OS Survey <survey@hsdos.ai>",
        to:      ["hearseedo.english@gmail.com"],
        subject: `📋 New struggle survey — ${struggles[0] || "open response"}`,
        html:    `<div style="font-family:sans-serif;max-width:560px">${lines}</div>`,
      }),
    }).catch(e => console.error("Resend failed:", e.message));
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
