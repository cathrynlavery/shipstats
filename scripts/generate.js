#!/usr/bin/env node
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const USERNAME =
  process.env.GITHUB_USERNAME ||
  (() => {
    throw new Error("GITHUB_USERNAME is required");
  })();
const TOKEN = process.env.GH_TOKEN;
const OUT_DIR = path.resolve(process.env.OUT_DIR || "dist");

const ADJECTIVES = [
  "Mysterious",
  "Secret",
  "Ancient",
  "Cosmic",
  "Phantom",
  "Sneaky",
  "Rogue",
  "Cryptic",
  "Velvet",
  "Midnight",
];
const NOUNS = [
  "Penguin",
  "Capybara",
  "Narwhal",
  "Axolotl",
  "Quokka",
  "Pangolin",
  "Tapir",
  "Numbat",
  "Platypus",
  "Wombat",
];

function wackyName(repoFullName) {
  let hash = 0;
  for (const c of repoFullName) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return `${ADJECTIVES[hash % ADJECTIVES.length]} ${NOUNS[(hash >>> 4) % NOUNS.length]}`;
}

function githubGet(apiPath) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "shipstats/1.0",
      Accept: "application/vnd.github.v3+json",
    };
    if (TOKEN) headers["Authorization"] = `token ${TOKEN}`;

    https
      .get({ hostname: "api.github.com", path: apiPath, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 404) {
            resolve(null);
            return;
          }
          if (res.statusCode >= 400) {
            reject(
              new Error(
                `GitHub API ${res.statusCode} for ${apiPath}: ${Buffer.concat(chunks)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCommitStats(owner, repo, sha) {
  try {
    const data = await githubGet(`/repos/${owner}/${repo}/commits/${sha}`);
    if (!data?.stats) return { additions: 0, deletions: 0 };
    return {
      additions: data.stats.additions || 0,
      deletions: data.stats.deletions || 0,
    };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

async function main() {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const weekAgoISO = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log(`Fetching stats for ${USERNAME} (today: ${todayStr})`);

  // Get all repos pushed to in the last week
  let allRepos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await githubGet(
      `/user/repos?per_page=100&sort=pushed&direction=desc&page=${page}`,
    );
    if (!batch?.length) break;
    allRepos = allRepos.concat(batch);
    const oldest = batch[batch.length - 1];
    if (oldest?.pushed_at && oldest.pushed_at < weekAgoISO) break;
  }

  const activeRepos = allRepos.filter((r) => r.pushed_at >= weekAgoISO);
  console.log(`Scanning ${activeRepos.length} recently active repos`);

  // byDay: { date: { repoFullName: { additions, deletions } } }
  const byDay = {};
  const repoMeta = {}; // { repoFullName: { isPrivate } }

  for (const repo of activeRepos) {
    const repoFullName = repo.full_name;
    repoMeta[repoFullName] = { isPrivate: repo.private };

    // Get commits authored by USERNAME in the last 7 days
    let commits = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await githubGet(
        `/repos/${repoFullName}/commits?author=${USERNAME}&since=${weekAgoISO}&per_page=100&page=${page}`,
      );
      if (!batch?.length) break;
      commits = commits.concat(batch);
      if (batch.length < 100) break;
    }

    if (!commits.length) continue;
    console.log(`  ${repoFullName}: ${commits.length} commits`);

    const [owner, repoName] = repoFullName.split("/");
    for (const commit of commits) {
      const date = commit.commit.author.date.split("T")[0];
      const stats = await getCommitStats(owner, repoName, commit.sha);
      if (!byDay[date]) byDay[date] = {};
      if (!byDay[date][repoFullName])
        byDay[date][repoFullName] = { additions: 0, deletions: 0 };
      byDay[date][repoFullName].additions += stats.additions;
      byDay[date][repoFullName].deletions += stats.deletions;
      await sleep(80);
    }
  }

  // Aggregate weekly totals
  const weeklyByRepo = {};
  for (const repos of Object.values(byDay)) {
    for (const [repo, stats] of Object.entries(repos)) {
      if (!weeklyByRepo[repo])
        weeklyByRepo[repo] = { additions: 0, deletions: 0 };
      weeklyByRepo[repo].additions += stats.additions;
      weeklyByRepo[repo].deletions += stats.deletions;
    }
  }

  const todayByRepo = byDay[todayStr] || {};
  const todayTotal = Object.values(todayByRepo).reduce(
    (s, r) => s + r.additions,
    0,
  );
  const weekTotal = Object.values(weeklyByRepo).reduce(
    (s, r) => s + r.additions,
    0,
  );

  const displayName = (repoFullName) =>
    repoMeta[repoFullName]?.isPrivate
      ? wackyName(repoFullName)
      : repoFullName.split("/")[1];

  // Write output
  fs.mkdirSync(path.join(OUT_DIR, "daily"), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, "weekly"), { recursive: true });

  fs.writeFileSync(
    path.join(OUT_DIR, "index.html"),
    renderPage({
      todayStr,
      todayByRepo,
      todayTotal,
      weeklyByRepo,
      weekTotal,
      displayName,
      byDay,
    }),
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "daily", `${todayStr}.html`),
    renderPage({
      todayStr,
      todayByRepo,
      todayTotal,
      weeklyByRepo,
      weekTotal,
      displayName,
      byDay,
      isSnapshot: true,
    }),
  );

  const weekNum = getISOWeek(now);
  const weekLabel = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  fs.writeFileSync(
    path.join(OUT_DIR, "weekly", `${weekLabel}.html`),
    renderWeekPage({ weekLabel, weeklyByRepo, weekTotal, displayName, byDay }),
  );

  console.log(`Done. Today: +${todayTotal} lines. Week: +${weekTotal} lines.`);
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500&family=Geist+Mono:wght@300;400;500&display=swap" rel="stylesheet">`;

const BASE_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Geist Mono', 'Courier New', monospace;
      background: #fff;
      color: #111;
      min-height: 100vh;
      padding: 64px 32px 96px;
    }
    .wrap { max-width: 480px; margin: 0 auto; }
    .date { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: #aaa; margin-bottom: 20px; }
    .hero-num {
      font-family: 'Geist', sans-serif;
      font-size: 96px; font-weight: 400; color: #000;
      line-height: 1; letter-spacing: -0.03em;
    }
    .hero-sub { font-size: 11px; color: #aaa; margin-top: 12px; letter-spacing: .06em; text-transform: uppercase; }
    .section { margin-top: 64px; }
    .section-head {
      font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
      color: #aaa; border-top: 1px solid #000; padding-top: 12px; margin-bottom: 0;
    }
    .row {
      display: flex; justify-content: space-between; align-items: baseline;
      padding: 11px 0; border-bottom: 1px solid #ebebeb;
    }
    .label { font-size: 12px; color: #666; }
    .val { font-size: 12px; color: #000; font-weight: 500; }
    .sub-num {
      font-family: 'Geist', sans-serif;
      font-size: 48px; font-weight: 400; color: #000;
      line-height: 1; letter-spacing: -0.03em; margin: 20px 0 6px;
    }
    .empty { font-size: 11px; color: #ccc; padding: 14px 0; letter-spacing: .06em; text-transform: uppercase; }
    .permalink { margin-top: 72px; font-size: 11px; letter-spacing: .06em; }
    .permalink a { color: #aaa; text-decoration: none; border-bottom: 1px solid #e0e0e0; padding-bottom: 1px; }
    .permalink a:hover { color: #000; border-color: #000; }`;

function repoList(entries, displayName) {
  if (!entries.length) return `<p class="empty">nothing yet</p>`;
  return entries
    .sort((a, b) => b[1].additions - a[1].additions)
    .map(
      ([repo, stats]) => `
    <div class="row">
      <span class="label">${displayName(repo)}</span>
      <span class="val">+${fmt(stats.additions)}</span>
    </div>`,
    )
    .join("");
}

function renderPage({
  todayStr,
  todayByRepo,
  todayTotal,
  weeklyByRepo,
  weekTotal,
  displayName,
  byDay,
  isSnapshot,
}) {
  const todayEntries = Object.entries(todayByRepo);
  const weekEntries = Object.entries(weeklyByRepo);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${isSnapshot ? todayStr : "shipstats"}</title>
  ${FONTS}
  <style>${BASE_CSS}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="date">${todayStr}</div>
    <div class="hero-num">${todayTotal > 0 ? "+" + fmt(todayTotal) : "0"}</div>
    <div class="hero-sub">lines shipped today</div>

    <div class="section">
      <div class="section-head">today by project</div>
      ${repoList(todayEntries, displayName)}
    </div>

    <div class="section">
      <div class="section-head">this week</div>
      <div class="sub-num">+${fmt(weekTotal)}</div>
      <div class="hero-sub" style="margin-bottom:24px">lines total</div>
      ${repoList(weekEntries.slice(0, 8), displayName)}
    </div>

    ${!isSnapshot ? `<div class="permalink"><a href="./daily/${todayStr}.html">permalink for today &rarr;</a></div>` : ""}
  </div>
</body>
</html>`;
}

function renderWeekPage({
  weekLabel,
  weeklyByRepo,
  weekTotal,
  displayName,
  byDay,
}) {
  const weekEntries = Object.entries(weeklyByRepo);
  const dailyRows = Object.entries(byDay)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 7)
    .map(([date, repos]) => {
      const total = Object.values(repos).reduce((s, r) => s + r.additions, 0);
      return `<div class="row"><span class="label">${date}</span><span class="val">+${fmt(total)}</span></div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${weekLabel} — shipstats</title>
  ${FONTS}
  <style>${BASE_CSS}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="date">${weekLabel}</div>
    <div class="hero-num">+${fmt(weekTotal)}</div>
    <div class="hero-sub">lines shipped this week</div>

    <div class="section">
      <div class="section-head">by project</div>
      ${repoList(weekEntries, displayName)}
    </div>

    <div class="section">
      <div class="section-head">by day</div>
      ${dailyRows || '<p class="empty">no activity</p>'}
    </div>
  </div>
</body>
</html>`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
