const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fnPath = path.join(__dirname, "..", "netlify", "functions", "founding-interest.js");

let sent = [], resendStatus = 200;
global.fetch = async (u, o) => { sent.push({ u, o }); return { ok: resendStatus < 300, status: resendStatus }; };
const load = (key) => { delete require.cache[fnPath]; process.env.RESEND_API_KEY = key; return require(fnPath).handler; };
const post = (h, b, ip = "1.1.1.1") => h({ httpMethod: "POST", body: JSON.stringify(b), headers: { "x-nf-client-connection-ip": ip } });

test("success sends one escaped email to the owner only, reply-to the visitor", async () => {
  const h = load("re_test"); sent = [];
  const r = await post(h, { name: "Aya <b>", email: "aya@example.com", note: "hi <script>", lang: "jp" });
  assert.equal(r.statusCode, 200); assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].o.body);
  assert(!body.html.includes("<script>") && !body.html.includes("<b>"));
  assert.equal(body.reply_to, "aya@example.com"); assert.deepEqual(body.to, ["hearseedo.english@gmail.com"]);
});
test("rejects missing name, bad email, oversize and wrong method", async () => {
  const h = load("re_test");
  assert.equal((await post(h, { name: "", email: "a@b.co" }, "2.2.2.2")).statusCode, 400);
  assert.equal((await post(h, { name: "x", email: "nope" }, "2.2.2.2")).statusCode, 400);
  assert.equal((await h({ httpMethod: "POST", body: "x".repeat(5000) })).statusCode, 413);
  assert.equal((await h({ httpMethod: "GET" })).statusCode, 405);
});
test("honeypot is acknowledged but sends nothing", async () => {
  const h = load("re_test"); sent = [];
  assert.equal((await post(h, { name: "bot", email: "a@b.co", website: "spam.example" }, "3.3.3.3")).statusCode, 200);
  assert.equal(sent.length, 0);
});
test("a Resend failure is never reported as success", async () => {
  const h = load("re_test"); resendStatus = 500;
  const r = await post(h, { name: "x", email: "a@b.co" }, "4.4.4.4");
  resendStatus = 200;
  assert.equal(r.statusCode, 502); assert.equal(JSON.parse(r.body).ok, false);
});
test("throttles repeated requests and fails closed without a key", async () => {
  let h = load("re_test"); const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(h, { name: "x", email: "a@b.co" }, "9.9.9.9")).statusCode);
  assert.equal(codes[6], 429);
  h = load("");
  assert.equal((await post(h, { name: "x", email: "a@b.co" }, "5.5.5.5")).statusCode, 503);
});
