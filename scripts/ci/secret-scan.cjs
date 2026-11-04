#!/usr/bin/env node
// Credential scanner. Never prints a secret: only file, line, rule and a short hash of the match.
//   node scripts/ci/secret-scan.cjs              scan every tracked file (what CI runs)
//   node scripts/ci/secret-scan.cjs --history    scan every line ever added on every branch (run before making a repo public / after a leak)
// Known test fixtures are listed explicitly in scripts/ci/secret-scan-allowlist.json (path + rule + reason), never by pattern.
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RULES = [
  ["private-key-block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["google-service-account", /"type"\s*:\s*"service_account"|"private_key_id"\s*:\s*"[0-9a-f]{20,}"/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe-secret-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["stripe-webhook-secret", /\bwhsec_[A-Za-z0-9]{24,}\b/],
  ["resend-key", /\bre_[A-Za-z0-9]{24,}\b/],
  ["netlify-token", /\bnfp_[A-Za-z0-9]{30,}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ["anthropic-or-openai-key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ["elevenlabs-key", /\bsk_[a-f0-9]{40,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["credentialed-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s:@\/]{6,}@[^\s\/]+/i],
];
// name = "long literal" assignments; skipped when the value is obviously a placeholder or read from the environment.
const ASSIGN = /(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([A-Za-z0-9\/+_.=-]{24,})["']/i;
const PLACEHOLDER = /(x{4,}|your[_-]|example|placeholder|changeme|dummy|fake|not[_-]?real|test[_-]?key|sample|\*{3,}|<[^>]+>|process\.env|\$\{)/i;
const RISKY_FILES = [/(^|\/)\.env(\..*)?$/, /\.(pem|p12|pfx|key)$/i, /adminsdk.*\.json$/i, /(^|\/)id_(rsa|ed25519)$/];
const SKIP_EXT = /\.(png|jpe?g|webp|gif|mp3|mp4|wav|mov|woff2?|ico|pdf|zip|svg|lockb?)$/i;

function short(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8); }
function scanLine(line) {
  const hits = [];
  if (line.length > 4000) line = line.slice(0, 4000);
  for (const [rule, re] of RULES) { const m = re.exec(line); if (m && !(rule === "credentialed-url" && PLACEHOLDER.test(m[0]))) hits.push({ rule, h: short(m[0]) }); }
  const a = ASSIGN.exec(line); if (a && !PLACEHOLDER.test(a[1]) && !PLACEHOLDER.test(line)) hits.push({ rule: "credential-assignment", h: short(a[1]) });
  return hits;
}
function loadAllowlist(root) {
  const p = path.join(root, "scripts", "ci", "secret-scan-allowlist.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8")).allow.map((e) => { if (!e.path || !e.rules || !e.reason) throw new Error("allowlist entries need path, rules and reason"); return e; });
}
const allowed = (allow, file, rule) => allow.some((e) => e.path === file && e.rules.includes(rule));
// A file allowlisted for private-key headers must still not contain a real-looking key body (a full 64-character PEM line).
const PEM_BODY_LINE = /(?:^|\\n|[^A-Za-z0-9+\/])[A-Za-z0-9+\/]{64}(?:\\n|\r?$)/;
function scanText(text, file, allow = []) {
  const out = [];
  const fixture = allowed(allow, file, "private-key-block");
  text.split("\n").forEach((line, i) => {
    for (const h of scanLine(line)) if (!allowed(allow, file, h.rule)) out.push({ file, line: i + 1, ...h });
    if (fixture) { const m = PEM_BODY_LINE.exec(line); if (m) out.push({ file, line: i + 1, rule: "real-looking-key-in-fixture", h: short(m[0]) }); }
  });
  return out;
}
function scanTracked(root) {
  const allow = loadAllowlist(root); const findings = [];
  const files = execFileSync("git", ["ls-files"], { cwd: root, maxBuffer: 1 << 28 }).toString().split("\n").filter(Boolean);
  for (const f of files) {
    if (RISKY_FILES.some((re) => re.test(f)) && !/\.example$|\.sample$/.test(f) && !allowed(allow, f, "risky-filename")) findings.push({ file: f, line: 0, rule: "risky-filename", h: short(f) });
    if (SKIP_EXT.test(f) || !fs.existsSync(path.join(root, f))) continue;
    const buf = fs.readFileSync(path.join(root, f)); if (buf.length > 3_000_000 || buf.includes(0)) continue;
    findings.push(...scanText(buf.toString("utf8"), f, allow));
  }
  return { findings, scanned: files.length };
}
function scanHistory(root) {
  return new Promise((resolve, reject) => {
    const allow = loadAllowlist(root); const findings = []; const seen = new Set(); let file = "", commit = "", n = 0, buf = "";
    const p = spawn("git", ["log", "--all", "-p", "-U0", "--no-color", "--format=@@COMMIT %h"], { cwd: root });
    const handle = (line) => {
      if (line.startsWith("@@COMMIT ")) { commit = line.slice(9); n++; return; }
      if (line.startsWith("+++ ")) { file = line.slice(6); return; }
      if (!line.startsWith("+") || SKIP_EXT.test(file)) return;
      for (const h of scanLine(line.slice(1))) {
        if (allowed(allow, file, h.rule)) continue;
        const key = h.rule + h.h; if (seen.has(key)) continue; seen.add(key);   // report each distinct secret once, at the commit that added it
        findings.push({ file, line: 0, ...h, commit });
      }
    };
    p.stdout.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); lines.forEach(handle); });
    p.on("close", () => { if (buf) handle(buf); resolve({ findings, scanned: n }); });
    p.on("error", reject);
  });
}
async function main() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
  const history = process.argv.includes("--history");
  const { findings, scanned } = history ? await scanHistory(root) : scanTracked(root);
  if (findings.length) {
    console.error(`Secret scan FAILED (${findings.length} finding(s); values are never printed):`);
    for (const f of findings) console.error(`  ${f.file}${f.line ? ":" + f.line : ""}  rule=${f.rule}  id=${f.h}${f.commit ? "  first-added-in=" + f.commit : ""}`);
    process.exit(1);
  }
  console.log(`Secret scan clean (${history ? scanned + " commits" : scanned + " tracked files"}).`);
}
module.exports = { scanText, scanLine, RULES };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(2); });
