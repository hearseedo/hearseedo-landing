// The scanner must catch each credential family (built at runtime so this file holds no credential-shaped literal),
// ignore placeholders and env reads, and keep fixtures explicit.
const test = require("node:test");
const assert = require("node:assert/strict");
const { scanText, scanLine } = require("../scripts/ci/secret-scan.cjs");
const rep = (c, n) => c.repeat(n);
const rules = (line) => scanLine(line).map((h) => h.rule);

test("detects each credential family", () => {
  const cases = {
    "stripe-secret-key": "const k = '" + "sk_" + "live_" + rep("a1", 14) + "'",
    "stripe-webhook-secret": "whsec" + "_" + rep("Ab", 16),
    "resend-key": "RESEND=re" + "_" + rep("Xy9", 10),
    "netlify-token": "nf" + "p_" + rep("a1B2", 9),
    "github-token": "gh" + "p_" + rep("a1B2c3", 7),
    "aws-access-key": "AK" + "IA" + rep("A1", 8),
    "slack-token": "xo" + "xb-" + rep("1234567890-", 3),
    "google-api-key": "AI" + "za" + rep("a1B", 11) + "aa",
    "anthropic-or-openai-key": "sk" + "-ant-" + rep("a1B2", 10),
    "jwt": "ey" + "J" + rep("a", 12) + ".ey" + "J" + rep("b", 12) + "." + rep("c", 12),
    "private-key-block": "-----BEGIN " + "PRIVATE KEY-----",
    "google-service-account": '{"type": "service' + '_account"}',
    "credentialed-url": "postgres://admin:" + rep("p4ss", 3) + "@db.internal/app",
    "credential-assignment": 'const apiToken = "' + rep("a1B2", 8) + '";',
  };
  for (const [rule, line] of Object.entries(cases)) assert.ok(rules(line).includes(rule), `${rule} not detected in: ${line.slice(0, 40)}…`);
});
test("ignores placeholders, env reads and ordinary code", () => {
  for (const line of ["const k = process.env.STRIPE_SECRET_KEY;", 'apiKey: "your-api-key-goes-here-xxxxxxxxxxxx"', "https://user:pass@example.com", 'const token = "<paste token here, 24+ chars long>";', "const x = 'hello world';", "Authorization: Bearer ${token}"]) assert.deepEqual(rules(line), [], line);
});
test("never returns the secret itself", () => {
  const secret = "sk" + "_live_" + rep("Zq", 14);
  assert.ok(!JSON.stringify(scanText("k=" + secret, "a.js")).includes(secret));
});
test("fixtures are allowed only when listed, only for that rule, and a real-looking key body still fails", () => {
  const hdr = "-----BEGIN " + "PRIVATE KEY-----\\nFAKE\\n-----END " + "PRIVATE KEY-----";
  const allow = [{ path: "t/fixture.cjs", rules: ["private-key-block"], reason: "x" }];
  assert.equal(scanText(hdr, "t/fixture.cjs", allow).length, 0);
  assert.ok(scanText(hdr, "t/other.cjs", allow).length > 0, "unlisted file must fail");
  const real = "-----BEGIN " + "PRIVATE KEY-----\\n" + rep("MIIEvQIBADAN", 6).slice(0, 64) + "\\n";
  assert.ok(scanText(real, "t/fixture.cjs", allow).some((f) => f.rule === "real-looking-key-in-fixture"));
  assert.ok(scanText("k=" + "sk_" + "live_" + rep("a1", 14), "t/fixture.cjs", allow).length > 0, "allowlist is per rule");
});
