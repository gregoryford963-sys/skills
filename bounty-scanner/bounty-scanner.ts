#!/usr/bin/env bun
/**
 * Bounty Scanner skill CLI
 * Autonomous bounty hunting — scan, match, claim, submit, and track bounties
 *
 * Usage: bun run bounty-scanner/bounty-scanner.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { signMessageHashRsv } from "@stacks/transactions";
import { hashMessage } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const BOUNTY_API =
  process.env.BOUNTY_API_URL ?? "https://bounty.drx4.xyz/api";

// ---------------------------------------------------------------------------
// Types (aligned with bounty.drx4.xyz data model)
// ---------------------------------------------------------------------------

interface Bounty {
  id: number;
  uuid: string;
  creator_stx: string;
  creator_name: string | null;
  title: string;
  description: string;
  amount_sats: number;
  tags: string | null;
  status: string; // open | claimed | submitted | approved | paid | cancelled
  deadline: string | null;
  claim_count: number;
  created_at: string;
  updated_at: string;
}

interface Claim {
  id: number;
  bounty_id: number;
  claimer_btc: string;
  claimer_stx: string | null;
  claimer_name: string | null;
  message: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface Submission {
  id: number;
  bounty_id: number;
  claim_id: number;
  proof_url: string | null;
  description: string;
  status: string;
  reviewer_notes: string | null;
  created_at: string;
}

interface Payment {
  id: number;
  bounty_id: number;
  submission_id: number;
  from_stx: string;
  to_stx: string;
  amount_sats: number;
  tx_hash: string;
  status: string;
  verified_at: string | null;
  created_at: string;
}

interface BountyDetail {
  bounty: Bounty;
  claims: Claim[];
  submissions: Submission[];
  payments: Payment[];
}

interface BountyListResponse {
  bounties: Bounty[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

interface StatsResponse {
  stats: {
    total_bounties: number;
    open_bounties: number;
    completed_bounties: number;
    cancelled_bounties: number;
    total_agents: number;
    total_paid_sats: number;
    total_claims: number;
    total_submissions: number;
  };
  timestamp: string;
}

interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchBounties(
  params?: Record<string, string>
): Promise<Bounty[]> {
  const url = new URL(`${BOUNTY_API}/bounties`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Bounty API returned ${res.status}`);
  const data = (await res.json()) as BountyListResponse;
  return data.bounties ?? [];
}

async function fetchBountyDetail(bountyId: number): Promise<BountyDetail> {
  const res = await fetch(`${BOUNTY_API}/bounties/${bountyId}`);
  if (!res.ok) throw new Error(`Bounty API returned ${res.status}`);
  return (await res.json()) as BountyDetail;
}

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${BOUNTY_API}/stats`);
  if (!res.ok) throw new Error(`Stats API returned ${res.status}`);
  return (await res.json()) as StatsResponse;
}

function getStxAddress(address?: string): string {
  if (address) return address;
  const walletManager = getWalletManager();
  const session = walletManager.getSessionInfo();
  if (session?.stxAddress) return session.stxAddress;
  throw new Error(
    "No STX address provided and wallet is not unlocked. " +
      "Either provide --address or unlock your wallet first."
  );
}

function requireUnlockedWallet() {
  const walletManager = getWalletManager();
  const account = walletManager.getActiveAccount();
  if (!account) {
    throw new Error(
      "Wallet is not unlocked. Use wallet/wallet.ts unlock first."
    );
  }
  return account;
}

/**
 * Sign a claim message proving control of the STX address.
 * Returns both the signature and the signed message so the server can verify.
 */
function signClaimMessage(
  bountyId: number,
  stxAddress: string,
  privateKey: string
): { signature: string; message: string; timestamp: string } {
  const timestamp = new Date().toISOString();
  const message = `claim:${bountyId}:${stxAddress}:${timestamp}`;
  const msgHash = hashMessage(message);
  const msgHashHex = bytesToHex(msgHash);
  const signature = signMessageHashRsv({
    messageHash: msgHashHex,
    privateKey,
  });
  return { signature, message, timestamp };
}

/**
 * Parse a bracket-list value like "[]" or "[wallet]" or "[l2, defi, write]".
 */
function parseBracketList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 */
function parseFrontmatter(content: string): SkillInfo | null {
  const lines = content.split("\n");
  let inFrontmatter = false;
  const frontmatterLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        break;
      }
    }
    if (inFrontmatter) {
      frontmatterLines.push(line);
    }
  }

  const fields: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  if (!fields.name) return null;

  return {
    name: fields.name,
    description: fields.description ?? "",
    tags: parseBracketList(fields.tags ?? "[]"),
  };
}

/**
 * Load installed skill names and descriptions.
 * First tries skills.json manifest, then falls back to scanning SKILL.md files.
 */
function getInstalledSkills(): SkillInfo[] {
  const repoRoot = join(import.meta.dir, "..");

  const manifestPath = join(repoRoot, "skills.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const skills: SkillInfo[] = [];
      for (const skill of manifest.skills ?? []) {
        skills.push({
          name: skill.name ?? "",
          description: skill.description ?? "",
          tags: skill.tags ?? [],
        });
      }
      if (skills.length > 0) return skills;
    } catch {
      // fall through to directory scan
    }
  }

  const skills: SkillInfo[] = [];
  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "src" ||
        entry.name === "scripts" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const skillMdPath = join(repoRoot, entry.name, "SKILL.md");
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, "utf-8");
          const info = parseFrontmatter(content);
          if (info) skills.push(info);
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // repo root unreadable — return empty
  }

  return skills;
}

/**
 * Score how well a bounty matches the agent's installed skills.
 * Returns 0-1 confidence score.
 */
function scoreBountyMatch(
  bounty: { title: string; description: string; tags: string | null },
  skills: SkillInfo[]
): { score: number; matchedSkills: string[]; reason: string } {
  const bountyText =
    `${bounty.title} ${bounty.description} ${bounty.tags ?? ""}`.toLowerCase();
  const matchedSkills: string[] = [];
  let score = 0;

  for (const skill of skills) {
    const skillWords =
      `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
    const skillTokens = skillWords
      .split(/[\s\-_,./]+/)
      .filter((t) => t.length > 2);

    let hits = 0;
    for (const token of skillTokens) {
      if (bountyText.includes(token)) hits++;
    }

    if (hits >= 2) {
      matchedSkills.push(skill.name);
      score += Math.min(hits * 0.15, 0.5);
    }
  }

  const mentionsPayment =
    /pay|transfer|send|sats|btc|stx|sbtc|escrow|fund/i.test(bountyText);
  const mentionsSigning = /sign|signature|verify|auth/i.test(bountyText);
  if (mentionsPayment && skills.some((s) => s.name === "wallet")) score += 0.1;
  if (mentionsSigning && skills.some((s) => s.name === "signing"))
    score += 0.1;

  score = Math.min(score, 1.0);

  const reason =
    matchedSkills.length > 0
      ? `Matches skills: ${matchedSkills.join(", ")}`
      : "No direct skill match — may require new capabilities";

  return { score: Math.round(score * 100) / 100, matchedSkills, reason };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command()
  .name("bounty-scanner")
  .description(
    "Autonomous bounty hunting — scan, match, claim, submit, and track bounties"
  );

// -- scan -------------------------------------------------------------------
program
  .command("scan")
  .description("List open bounties with rewards")
  .option("--status <status>", "Filter by status (default: open)", "open")
  .action(async (opts: { status: string }) => {
    try {
      const bounties = await fetchBounties({ status: opts.status });
      const mapped = bounties.map((b) => ({
        id: b.id,
        title: b.title,
        amount_sats: b.amount_sats,
        tags: b.tags,
        deadline: b.deadline,
        claim_count: b.claim_count,
        created_at: b.created_at,
      }));

      printJson({
        success: true,
        status: opts.status,
        count: mapped.length,
        bounties: mapped,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- match ------------------------------------------------------------------
program
  .command("match")
  .description("Match open bounties to your installed skills")
  .action(async () => {
    try {
      const bounties = await fetchBounties({ status: "open" });
      const skills = getInstalledSkills();

      const matches = bounties
        .map((b) => {
          const match = scoreBountyMatch(
            { title: b.title, description: b.description, tags: b.tags },
            skills
          );
          return {
            id: b.id,
            title: b.title,
            amount_sats: b.amount_sats,
            deadline: b.deadline,
            confidence: match.score,
            matchedSkills: match.matchedSkills,
            reason: match.reason,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);

      const recommended = matches.filter((m) => m.confidence >= 0.3);

      printJson({
        success: true,
        installedSkills: skills.length,
        openBounties: bounties.length,
        recommendedBounties: recommended.length,
        matches: matches.slice(0, 10),
        note: "Display threshold: 0.3 (recommended). Auto-claim threshold: 0.7 (see AGENT.md).",
        action:
          recommended.length > 0
            ? `Top match: "${recommended[0].title}" (${recommended[0].confidence * 100}% confidence, ${recommended[0].amount_sats} sats)`
            : "No strong matches found. Install more skills or check back later.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- detail -----------------------------------------------------------------
program
  .command("detail")
  .argument("<bounty-id>", "Bounty ID (integer)")
  .description("Show full bounty details including claims, submissions, payments")
  .action(async (bountyIdStr: string) => {
    try {
      const bountyId = parseInt(bountyIdStr, 10);
      if (isNaN(bountyId)) throw new Error("bounty-id must be an integer");

      const detail = await fetchBountyDetail(bountyId);
      printJson({
        success: true,
        ...detail,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- claim ------------------------------------------------------------------
program
  .command("claim")
  .argument("<bounty-id>", "Bounty ID (integer) to claim")
  .option("--message <text>", "Claim message (e.g. your plan or PR link)")
  .description("Claim a bounty for your agent (requires unlocked wallet)")
  .action(async (bountyIdStr: string, opts: { message?: string }) => {
    try {
      const bountyId = parseInt(bountyIdStr, 10);
      if (isNaN(bountyId)) throw new Error("bounty-id must be an integer");

      const account = requireUnlockedWallet();
      const stxAddress = account.address;
      const { signature, message: signedMsg } = signClaimMessage(
        bountyId,
        stxAddress,
        account.privateKey
      );

      const res = await fetch(`${BOUNTY_API}/bounties/${bountyId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claimer_stx: stxAddress,
          message: opts.message ?? signedMsg,
          signature,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        printJson({
          success: false,
          error:
            (data as Record<string, unknown>).error ?? `HTTP ${res.status}`,
          bountyId,
        });
        return;
      }

      printJson({
        success: true,
        bountyId,
        claimer_stx: stxAddress,
        message:
          "Bounty claimed. Build your solution and submit with the submit command.",
        ...(data as object),
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- submit -----------------------------------------------------------------
program
  .command("submit")
  .argument("<bounty-id>", "Bounty ID (integer)")
  .requiredOption(
    "--description <text>",
    "Description of your submission (what you built)"
  )
  .option("--proof-url <url>", "URL to PR or proof of work")
  .description("Submit work for a claimed bounty (requires unlocked wallet)")
  .action(
    async (
      bountyIdStr: string,
      opts: { description: string; proofUrl?: string }
    ) => {
      try {
        const bountyId = parseInt(bountyIdStr, 10);
        if (isNaN(bountyId)) throw new Error("bounty-id must be an integer");

        // Fetch bounty detail to get UUID (submit endpoint uses UUID)
        const detail = await fetchBountyDetail(bountyId);
        const uuid = detail.bounty.uuid;

        const account = requireUnlockedWallet();
        const stxAddress = account.address;
        const timestamp = new Date().toISOString();

        // Sign using Stacks message signing
        const message = `agent-bounties | submit-work | ${stxAddress} | bounties/${uuid} | ${timestamp}`;
        const msgHash = hashMessage(message);
        const msgHashHex = bytesToHex(msgHash);
        const signature = signMessageHashRsv({
          messageHash: msgHashHex,
          privateKey: account.privateKey,
        });

        const body: Record<string, unknown> = {
          stx_address: stxAddress,
          signature,
          timestamp,
          description: opts.description,
        };
        if (opts.proofUrl) body.proof_url = opts.proofUrl;

        const res = await fetch(`${BOUNTY_API}/bounties/${uuid}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();

        if (!res.ok) {
          printJson({
            success: false,
            error:
              (data as Record<string, unknown>).error ?? `HTTP ${res.status}`,
            bountyId,
            uuid,
          });
          return;
        }

        printJson({
          success: true,
          bountyId,
          uuid,
          message: "Submission received. Awaiting review.",
          ...(data as object),
        });
      } catch (err) {
        handleError(err);
      }
    }
  );

// -- status -----------------------------------------------------------------
program
  .command("status")
  .description("Bounty board health — stats from the API")
  .action(async () => {
    try {
      const { stats, timestamp } = await fetchStats();

      printJson({
        success: true,
        ...stats,
        timestamp,
        summary: `${stats.open_bounties} open bounties | ${stats.total_paid_sats.toLocaleString()} sats paid | ${stats.total_agents} agents`,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- my-bounties ------------------------------------------------------------
program
  .command("my-bounties")
  .description("List bounties you have created or claimed")
  .option("--address <stx>", "Your STX address")
  .action(async (opts: { address?: string }) => {
    try {
      const stxAddress = getStxAddress(opts.address);
      const bounties = await fetchBounties();

      const created = bounties.filter((b) => b.creator_stx === stxAddress);

      // For claimed bounties we need to check claims on each bounty.
      // Fetch detail only for bounties with claims to find ours.
      const claimedBounties: Array<{
        bounty: Bounty;
        claim: Claim;
      }> = [];

      const withClaims = bounties.filter((b) => b.claim_count > 0);
      for (const b of withClaims) {
        try {
          const detail = await fetchBountyDetail(b.id);
          const myClaim = detail.claims.find(
            (c) => c.claimer_stx === stxAddress
          );
          if (myClaim) {
            claimedBounties.push({ bounty: b, claim: myClaim });
          }
        } catch {
          // skip bounties we can't fetch detail for
        }
      }

      printJson({
        success: true,
        agent: stxAddress,
        created: created.map((b) => ({
          id: b.id,
          title: b.title,
          status: b.status,
          amount_sats: b.amount_sats,
        })),
        claimed: claimedBounties.map(({ bounty, claim }) => ({
          id: bounty.id,
          title: bounty.title,
          bounty_status: bounty.status,
          claim_id: claim.id,
          claim_status: claim.status,
          amount_sats: bounty.amount_sats,
        })),
        summary: `${created.length} created, ${claimedBounties.length} claimed`,
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
