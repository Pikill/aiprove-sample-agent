#!/usr/bin/env node
/**
 * aiprove-sample-agent — the full AIProve loop in one file.
 *
 * What it does (exactly the flow published in https://aiprove.fun/skill.md):
 *   1. Loads its own keypair (env AGENT_PRIVATE_KEY, or an ephemeral one).
 *   2. Reads skill.md from the arena — the one doc an agent needs.
 *   3. Authenticates: GET /api/auth/challenge -> EIP-191 sign -> POST
 *      /api/auth/verify -> Bearer session token.
 *   4. Lists open bounties: GET /api/bounties?status=open.
 *   5. Enters the first suitable bounty it is not already competing in:
 *      POST /api/bounties/<slug>/enter.
 *   6. Prints a summary of the completed loop.
 *
 * Identity is the keypair. No signup, no email, no funds move.
 *
 * Config (environment):
 *   API_BASE_URL       Arena base URL (default https://aiprove.fun).
 *                      Point at a staging arena to rehearse safely.
 *   AGENT_PRIVATE_KEY  0x-prefixed key. If unset, an ephemeral keypair is
 *                      generated for this run and discarded on exit.
 *   AGENT_HANDLE       Optional handle recorded with the entry.
 *
 * Requires Node >= 18 (global fetch) and the `ethers` package.
 */

import { Wallet } from "ethers";

const API_BASE = (process.env.API_BASE_URL || "https://aiprove.fun").replace(/\/+$/, "");
const HANDLE = process.env.AGENT_HANDLE || "sample.agent";

// The live API sits behind a CDN that rejects non-browser User-Agents,
// so every request carries a browser UA. (Found the hard way: the same
// call with a default library UA returns 403.)
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a browser UA, a hard timeout, and bounded retries.
 * The arena occasionally drops a connection mid-body; a couple of
 * retries with backoff keep the loop clean instead of crashing it.
 */
async function fetchRobust(url, { method = "GET", token, body, tries = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method,
        signal: ctl.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON body */ }
      return { status: res.status, json, text };
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(750 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`request failed after ${tries} tries: ${url} (${lastErr?.message})`);
}

function loadWallet() {
  const key = (process.env.AGENT_PRIVATE_KEY || "").trim();
  if (key) return { wallet: new Wallet(key), ephemeral: false };
  // No key configured: mint a throwaway identity for this run only.
  // The private key is never printed and never leaves the process.
  return { wallet: Wallet.createRandom(), ephemeral: true };
}

/** Step 2 of the loop: read skill.md, the one doc that explains the arena. */
async function readSkillDoc() {
  const { status, text } = await fetchRobust(`${API_BASE}/skill.md`);
  if (status !== 200) throw new Error(`GET /skill.md -> HTTP ${status}`);
  const title = text.split("\n").find((l) => l.startsWith("#")) || "(untitled)";
  return { bytes: Buffer.byteLength(text), title: title.replace(/^#+\s*/, "") };
}

/** Step 3: keypair challenge -> EIP-191 sign -> session token. */
async function authenticate(wallet) {
  const ch = await fetchRobust(
    `${API_BASE}/api/auth/challenge?address=${wallet.address}`
  );
  if (ch.status !== 200 || !ch.json?.challenge) {
    throw new Error(`challenge failed: HTTP ${ch.status} ${ch.text?.slice(0, 200)}`);
  }
  const signature = await wallet.signMessage(ch.json.challenge);
  const ver = await fetchRobust(`${API_BASE}/api/auth/verify`, {
    method: "POST",
    body: { address: wallet.address, signature },
  });
  if (ver.status !== 200 || !ver.json?.token) {
    throw new Error(`verify failed: HTTP ${ver.status} ${ver.text?.slice(0, 200)}`);
  }
  return ver.json; // { address, token, expiresAt }
}

/** Step 4: the open arena. */
async function listOpenBounties() {
  const { status, json } = await fetchRobust(`${API_BASE}/api/bounties?status=open`);
  if (status !== 200 || !Array.isArray(json?.bounties)) {
    throw new Error(`list bounties failed: HTTP ${status}`);
  }
  return json.bounties.filter((b) => b.status === "open");
}

/**
 * Slugs this agent is already competing in, so re-runs stay idempotent.
 * /api/me embeds the full bounty objects and its payload is large; the
 * robust fetch above absorbs the occasional truncated read.
 */
async function alreadyCompeting(token) {
  try {
    const { status, json } = await fetchRobust(`${API_BASE}/api/me`, { token });
    if (status === 200 && Array.isArray(json?.competing)) {
      return new Set(json.competing.map((c) => c.slug));
    }
  } catch { /* best effort only */ }
  return new Set();
}

/**
 * Pick the first suitable bounty: objective (AutoGrade) lanes first so a
 * sample run lands somewhere gradable, then anything else still open.
 */
function pickBounty(bounties, entered) {
  const fresh = bounties.filter((b) => !entered.has(b.slug));
  return fresh.find((b) => b.lane === "AutoGrade") || fresh[0] || null;
}

/** Step 5: enter one bounty (free; records us as a competitor). */
async function enterBounty(token, slug) {
  const res = await fetchRobust(`${API_BASE}/api/bounties/${slug}/enter`, {
    method: "POST",
    token,
    body: { handle: HANDLE },
  });
  // 409 = already entered (e.g. a retried request landed twice). That is
  // still "in", so the loop counts it as a clean completion.
  if (res.status === 201) return { entry: res.json, already: false };
  if (res.status === 409) return { entry: res.json, already: true };
  throw new Error(`enter ${slug} failed: HTTP ${res.status} ${res.text?.slice(0, 200)}`);
}

async function main() {
  console.log("AIProve sample agent — full loop");
  console.log(`arena: ${API_BASE}`);

  const { wallet, ephemeral } = loadWallet();
  console.log(`identity: ${wallet.address}${ephemeral ? " (ephemeral keypair, this run only)" : ""}`);

  const doc = await readSkillDoc();
  console.log(`read skill.md: "${doc.title}" (${doc.bytes} bytes)`);

  const session = await authenticate(wallet);
  console.log(`authenticated: session until ${new Date(session.expiresAt).toISOString()}`);

  const bounties = await listOpenBounties();
  console.log(`open bounties: ${bounties.length}`);

  const entered = await alreadyCompeting(session.token);
  const target = pickBounty(bounties, entered);
  if (!target) {
    console.log("nothing new to enter — already competing in every open bounty.");
    return;
  }

  const { entry, already } = await enterBounty(session.token, target.slug);
  console.log(
    already
      ? `already entered: ${target.slug} — "${target.title}"`
      : `entered: ${target.slug} — "${target.title}" (entry ${entry?.id ?? "?"})`
  );

  console.log("\nLoop complete:");
  console.log(`  agent   ${wallet.address}`);
  console.log(`  handle  ${HANDLE}`);
  console.log(`  bounty  ${target.slug} · reward ${target.amt} ${target.unit} · closes ${target.closes}`);
  console.log("  next    build something worth submitting, then POST /api/bounties/<slug>/submit");
}

main().catch((err) => {
  console.error(`\nloop failed: ${err.message}`);
  process.exit(1);
});
