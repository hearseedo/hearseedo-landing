const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
execFileSync("bash", [path.join(root, "scripts", "build-site.sh")], { cwd: root, stdio: "pipe" });
const site = path.join(root, "_site");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(site).map((f) => path.relative(site, f));

test("published bundle contains no drafts, function source, config or env files", () => {
  const bad = files.filter((f) => /^(index-old|index-new)\.html$|^netlify|^package|^\.env|^scripts\/|^tests\/|\.json$|\.js$|\.cjs$|\.sh$|^\.git/.test(f));
  assert.deepEqual(bad, []);
});
test("security headers are present", () => {
  const h = fs.readFileSync(path.join(site, "_headers"), "utf8");
  for (const k of ["Strict-Transport-Security", "Content-Security-Policy", "X-Frame-Options: DENY", "X-Content-Type-Options: nosniff", "Referrer-Policy", "Permissions-Policy", "frame-ancestors 'none'", "object-src 'none'"]) assert(h.includes(k), "missing " + k);
});
test("security.txt and robots.txt are published", () => {
  assert(files.includes(".well-known/security.txt")); assert(files.includes("robots.txt"));
});
test("pages never send visitors into the password-protected app checkout", () => {
  for (const f of ["index.html", "terms.html", "privacy.html", "about-jona.html"]) {
    const t = fs.readFileSync(path.join(site, f), "utf8");
    assert(!/app\.hsdos\.ai\/(founding|demo)/.test(t), f + " links into the locked app");
  }
});
test("every local file a page references exists in the bundle", () => {
  const missing = [];
  for (const f of files.filter((x) => x.endsWith(".html"))) {
    const t = fs.readFileSync(path.join(site, f), "utf8");
    for (const m of t.matchAll(/(?:src|poster|href)="(?!https?:|mailto:|#|data:|tel:)([^"?#]+\.(?:mp4|png|jpg|jpeg|webp|svg|ico|html|mp3))"/g)) {
      const rel = m[1].replace(/^\//, "");
      if (!fs.existsSync(path.join(site, rel))) missing.push(f + " -> " + m[1]);
    }
  }
  assert.deepEqual(missing, []);
});
test("no credentials in tracked files or in any commit (shared scanner)", () => {
  execFileSync("node", [path.join(root, "scripts", "ci", "secret-scan.cjs")], { cwd: root, stdio: "pipe" });
  execFileSync("node", [path.join(root, "scripts", "ci", "secret-scan.cjs"), "--history"], { cwd: root, stdio: "pipe" });
});
test("the unused survey endpoint stays disabled", async () => {
  const r = await require(path.join(root, "netlify", "functions", "struggle-survey.js")).handler({ httpMethod: "POST", body: "{}" });
  assert.equal(r.statusCode, 410);
});
