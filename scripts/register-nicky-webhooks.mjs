#!/usr/bin/env node
// =============================================================================
// One-time Nicky webhook registration — SETUP/INSTALL helper
// =============================================================================
//
// This is NOT runtime plugin code and NOT a Supabase Edge Function. It is a
// local setup helper you run ONCE, after deploying the Edge Functions, to
// register the fixed webhook callback URL with Nicky for the required events.
//
// The plugin runtime only PROCESSES webhooks (see supabase/functions/nicky-webhook).
// It never registers, lists, updates, or deletes them.
//
// Requirements: Node 18+ (uses built-in global `fetch`). No dependencies.
//
// Environment variables (see scripts/.env.webhook.example):
//   NICKY_API_KEY        required  — used only here/server-side; never printed
//   NICKY_API_BASE_URL   optional  — default https://api-public.pay.nicky.me
//   NICKY_WEBHOOK_URL    required  — https://<project-ref>.functions.supabase.co/nicky-webhook
//
// Usage:
//   NICKY_API_KEY=... NICKY_WEBHOOK_URL=https://<ref>.functions.supabase.co/nicky-webhook \
//     node scripts/register-nicky-webhooks.mjs
//   # or: npm run nicky:register-webhooks
//
//   Add --dry-run to validate inputs and print the intended plan WITHOUT making
//   any network calls to Nicky.
//
// Behavior (idempotent):
//   1. GET  /api/public/WebHookApi/list
//   2. For each required event, if a webhook already exists for that event type
//      AND this URL, leave it (no-op). Otherwise create it via
//      POST /api/public/WebHookApi/create.
//   It never deletes or updates existing webhooks.

import {
  REQUIRED_EVENTS,
  validateSetupEnv,
  maskApiKey,
  extractWebhookList,
  planWebhookActions,
  buildCreateBody,
} from "./webhook-registration-helpers.mjs";

const DEFAULT_API_BASE_URL = "https://api-public.pay.nicky.me";

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`✖ ${msg}\n`);
  process.exit(1);
}

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // --- Read + validate environment ---------------------------------------
  const apiKey = process.env.NICKY_API_KEY;
  const webhookUrl = process.env.NICKY_WEBHOOK_URL;
  const apiBaseUrl = stripTrailingSlash(process.env.NICKY_API_BASE_URL || DEFAULT_API_BASE_URL);

  const check = validateSetupEnv({ apiKey, webhookUrl });
  if (!check.ok) {
    for (const err of check.errors) process.stderr.write(`✖ ${err}\n`);
    process.stderr.write(
      "\nSee scripts/.env.webhook.example for the required setup variables.\n",
    );
    process.exit(1);
  }

  log("Nicky webhook registration (one-time setup)");
  log("─".repeat(48));
  log(`API base URL : ${apiBaseUrl}`);
  log(`Webhook URL  : ${check.webhookUrl}`);
  log(`API key      : ${maskApiKey(check.apiKey)}`); // masked — never the full key
  log(`Events       : ${REQUIRED_EVENTS.join(", ")}`);
  log("");

  if (dryRun) {
    log("--dry-run: skipping all network calls. Intended actions (assuming none exist yet):");
    for (const event of REQUIRED_EVENTS) {
      log(`  • ${event} -> would create at ${check.webhookUrl}`);
    }
    log("\nDry run complete. No requests were sent to Nicky.");
    return;
  }

  const headers = {
    "x-api-key": check.apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // --- 1. List existing webhooks -----------------------------------------
  let existing;
  try {
    const res = await fetch(`${apiBaseUrl}/api/public/WebHookApi/list`, { headers });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      fail(`Failed to list webhooks (HTTP ${res.status}). Check your API key and base URL.`);
    }
    existing = extractWebhookList(data);
  } catch (err) {
    fail(`Network error while listing webhooks: ${err?.message ?? err}`);
  }

  log(`Found ${existing.length} existing webhook(s) on the account.`);

  // --- 2. Plan + create missing ------------------------------------------
  const plan = planWebhookActions({ existing, url: check.webhookUrl });

  let created = 0;
  let already = 0;

  for (const item of plan) {
    if (item.action === "exists") {
      already += 1;
      log(`  ✓ ${item.eventType} — already registered for this URL (no change).`);
      continue;
    }

    try {
      const res = await fetch(`${apiBaseUrl}/api/public/WebHookApi/create`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildCreateBody(item.eventType, check.webhookUrl)),
      });
      const data = await parseJsonSafe(res);
      if (!res.ok) {
        fail(`Failed to create webhook for ${item.eventType} (HTTP ${res.status}).`);
      }
      created += 1;
      const id = data && typeof data === "object" ? data.id : undefined;
      log(`  + ${item.eventType} — created${id ? ` (id ${id})` : ""}.`);
    } catch (err) {
      fail(`Network error while creating webhook for ${item.eventType}: ${err?.message ?? err}`);
    }
  }

  log("");
  log(`Done. ${created} created, ${already} already existed. Both required events are configured.`);
}

main().catch((err) => {
  fail(`Unexpected error: ${err?.message ?? err}`);
});
