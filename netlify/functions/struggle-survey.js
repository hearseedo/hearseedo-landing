// DISABLED 2026-11-04. Nothing on the site calls this endpoint, and it was an open, unauthenticated
// writer to Firestore and a free email sender (submitter text went into the HTML email unescaped).
// The previous version is in git history. Re-enable only with validation, escaping and rate limiting.
exports.handler = async () => ({
  statusCode: 410,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify({ ok: false, error: "gone" }),
});
