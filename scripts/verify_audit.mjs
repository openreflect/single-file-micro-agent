#!/usr/bin/env node
// Offline verifier for an SFMA trace/result pair. No secrets or model access.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

function verifyTrace(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parsed = lines.map((line) => JSON.parse(line));
  const firstChained = parsed.findIndex((e) => e.hash || e.prevHash);
  if (firstChained < 0) fail("trace has no hash-chained entries");
  if (parsed.slice(0, firstChained).some((e) => e.hash || e.prevHash)
      || parsed.slice(firstChained).some((e) => !e.hash || !e.prevHash)) fail("invalid legacy/hash-chain boundary");
  let previous = firstChained
    ? digest(lines.slice(0, firstChained).map((line) => line + "\n").join(""))
    : "0".repeat(64);
  for (const e of parsed.slice(firstChained)) {
    const hash = e.hash, body = { ...e };
    delete body.hash;
    if (body.prevHash !== previous) fail(`broken prevHash at ${e.id}`);
    if (digest(stable(body)) !== hash) fail(`invalid entry hash at ${e.id}`);
    previous = hash;
  }
  return { headHash: previous, entries: parsed.length };
}

try {
  const target = process.argv[2];
  if (!target) fail("usage: verify_audit.mjs <workspace-or-result.json>");
  const resultFile = target.endsWith(".json") ? path.resolve(target) : path.resolve(target, ".sfma", "result.json");
  const record = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const integrity = record.integrity;
  if (!integrity || integrity.algorithm !== "sha256-chain-v1") fail("result has no supported integrity record");
  const traceFile = path.resolve(path.dirname(resultFile), path.basename(record.trace));
  const trace = verifyTrace(traceFile);
  if (trace.headHash !== integrity.headHash || trace.entries !== integrity.entries) fail("result does not match trace head/count");
  if (digest(stable(record.manifest)) !== integrity.manifestSha256) fail("manifest digest mismatch");
  const base = { ...record }; delete base.integrity;
  if (digest(stable(base)) !== integrity.resultSha256) fail("result digest mismatch");
  let signatureStatus = "none";
  if (integrity.signature) {
    const signature = integrity.signature;
    const payload = { ...integrity }; delete payload.signature;
    const trustedKey = process.env.SFMA_AUDIT_PUBLIC_KEY;
    const verificationKey = trustedKey || signature.publicKey;
    if (signature.algorithm !== "ed25519"
        || !crypto.verify(null, Buffer.from(stable(payload)), verificationKey, Buffer.from(signature.value, "base64"))) {
      fail("invalid audit signature");
    }
    if (trustedKey) {
      const embedded = crypto.createPublicKey(signature.publicKey).export({ type: "spki", format: "pem" });
      const trusted = crypto.createPublicKey(trustedKey).export({ type: "spki", format: "pem" });
      if (embedded !== trusted) fail("embedded signing key does not match trusted public key");
      signatureStatus = "trusted";
    } else signatureStatus = "untrusted-key";
  }
  console.log(`AUDIT_OK signature=${signatureStatus} entries=${trace.entries} head=${trace.headHash}`);
} catch (err) {
  console.error(`AUDIT_INVALID: ${err.message}`);
  process.exit(1);
}
