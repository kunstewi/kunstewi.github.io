#!/usr/bin/env node

/**
 * fetch_prs.js
 *
 * Fetches all merged pull requests authored by a GitHub user and writes
 * them to ../prs/prs.json in the format consumed by prs.html.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node fetch_prs.js [--username kunstewi]
 *
 * Environment variables:
 *   GITHUB_TOKEN  – A GitHub personal access token (classic or fine-grained).
 *                   Required to avoid rate-limiting and to access private repos.
 *
 * Options:
 *   --username    – GitHub username to fetch PRs for (default: kunstewi)
 *   --output      – Output file path (default: ../prs/prs.json)
 *   --dry-run     – Print the results to stdout without writing to file
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Load .env file (so you can keep GITHUB_TOKEN in scripts/.env)
// ---------------------------------------------------------------------------

const envPath = path.resolve(__dirname, ".env");
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function getArg(name, fallback) {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1]
        ? process.argv[idx + 1]
        : fallback;
}

const USERNAME = getArg("username", "kunstewi");
const OUTPUT_PATH = path.resolve(
    __dirname,
    getArg("output", "../prs/prs.json")
);
const DRY_RUN = process.argv.includes("--dry-run");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
    console.error(
        "Error: GITHUB_TOKEN environment variable is required.\n" +
        "Create one at https://github.com/settings/tokens and set it:\n" +
        "  GITHUB_TOKEN=ghp_xxx node fetch_prs.js"
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const API_BASE = "https://api.github.com";

const HEADERS = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "fetch-prs-script",
    "X-GitHub-Api-Version": "2022-11-28",
};

/**
 * Fetch a single page from the GitHub API.
 * Returns { data, nextUrl } where nextUrl is null when there are no more pages.
 */
async function fetchPage(url) {
    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API ${res.status}: ${body}`);
    }

    const data = await res.json();

    // Parse the Link header for pagination
    const link = res.headers.get("link") || "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    const nextUrl = nextMatch ? nextMatch[1] : null;

    return { data, nextUrl };
}

/**
 * Fetch all pages from a paginated GitHub API endpoint.
 */
async function fetchAllPages(url) {
    const results = [];
    let currentUrl = url;

    while (currentUrl) {
        const { data, nextUrl } = await fetchPage(currentUrl);
        results.push(...(Array.isArray(data) ? data : data.items || []));
        currentUrl = nextUrl;
    }

    return results;
}

// ---------------------------------------------------------------------------
// Label classification
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable label from the PR title.
 * Tries to detect common prefixes like "fix:", "feat:", "docs:", etc.
 */
function classifyLabel(title) {
    const lower = title.toLowerCase();

    // Match conventional-commit-style prefixes
    if (/^\[?\s*fix/i.test(lower)) return "bug fix";
    if (/^\[?\s*feat/i.test(lower)) return "feature";
    if (/^\[?\s*docs?/i.test(lower)) return "docs";
    if (/^\[?\s*refactor/i.test(lower)) return "refactor";
    if (/^\[?\s*chore/i.test(lower)) return "chore";
    if (/^\[?\s*test/i.test(lower)) return "test";
    if (/^\[?\s*perf/i.test(lower)) return "performance";
    if (/^\[?\s*style/i.test(lower)) return "chore";
    if (/^\[?\s*ci/i.test(lower)) return "chore";
    if (/^\[?\s*build/i.test(lower)) return "chore";
    if (/^\[?\s*security/i.test(lower)) return "security";
    if (/^\[?\s*breaking/i.test(lower)) return "breaking";

    // Check for [BACKEND], [FIX], etc. bracket prefixes
    const bracketMatch = lower.match(/^\[\s*(\w+)\s*\]/);
    if (bracketMatch) {
        const tag = bracketMatch[1];
        if (tag === "fix") return "bug fix";
        if (tag === "feat" || tag === "feature") return "feature";
        if (tag === "backend" || tag === "frontend") return "feature";
        if (tag === "docs" || tag === "doc") return "docs";
        if (tag === "refactor") return "refactor";
        if (tag === "chore") return "chore";
        if (tag === "test") return "test";
    }

    return "other";
}

/**
 * Format a date string like "Feb 27, 2026"
 */
function formatDate(isoDate) {
    return new Date(isoDate).toLocaleDateString("en-US", {
        month: "short",
        day: "2-digit",
        year: "numeric",
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log(`Fetching merged PRs for @${USERNAME}…\n`);

    // Use the Search API to find all merged PRs authored by the user.
    // This is the most efficient way since it works across all repos.
    const searchUrl = `${API_BASE}/search/issues?q=author:${USERNAME}+type:pr+is:merged&sort=updated&order=desc&per_page=100`;
    const prs = await fetchAllPages(searchUrl);

    console.log(`Found ${prs.length} merged PR(s). Fetching details…\n`);

    // For each PR, we need the detailed PR endpoint to get filesChanged,
    // additions, and deletions.
    const results = [];

    for (const pr of prs) {
        // Extract owner/repo from the PR's repository_url
        // Format: https://api.github.com/repos/{owner}/{repo}
        const repoUrl = pr.repository_url;
        const repoPath = repoUrl.replace(`${API_BASE}/repos/`, "");
        const repoName = repoPath.split("/").pop();

        // Fetch detailed PR data (the search endpoint doesn't include file stats)
        const prNumber = pr.number;
        const detailUrl = `${API_BASE}/repos/${repoPath}/pulls/${prNumber}`;

        let filesChanged = 0;
        let additions = 0;
        let deletions = 0;
        let mergedOn = "";

        try {
            const { data: detail } = await fetchPage(detailUrl);
            filesChanged = detail.changed_files || 0;
            additions = detail.additions || 0;
            deletions = detail.deletions || 0;
            mergedOn = detail.merged_at
                ? formatDate(detail.merged_at)
                : formatDate(pr.closed_at || pr.updated_at);
        } catch (err) {
            console.warn(
                `  ⚠ Could not fetch details for ${repoPath}#${prNumber}: ${err.message}`
            );
            mergedOn = formatDate(pr.closed_at || pr.updated_at);
        }

        const entry = {
            title: pr.title,
            url: pr.html_url,
            label: classifyLabel(pr.title),
            repo: repoName,
            mergedOn,
            filesChanged,
            additions,
            deletions,
        };

        results.push(entry);
        process.stdout.write(`  ✓ ${repoName}#${prNumber}: ${pr.title}\n`);
    }

    // Sort by merge date descending (most recent first)
    results.sort((a, b) => new Date(b.mergedOn) - new Date(a.mergedOn));

    const json = JSON.stringify(results, null, 2) + "\n";

    if (DRY_RUN) {
        console.log("\n--- DRY RUN (not writing to file) ---\n");
        console.log(json);
    } else {
        fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
        fs.writeFileSync(OUTPUT_PATH, json, "utf-8");
        console.log(`\n✅ Wrote ${results.length} PR(s) to ${OUTPUT_PATH}`);
    }
}

main().catch((err) => {
    console.error(`\n❌ Fatal error: ${err.message}`);
    process.exit(1);
});
