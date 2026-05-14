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
  const weekAgoStr = new Date(now - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  console.log(`Fetching events for ${USERNAME} (today: ${todayStr})`);

  // Collect push events from the last 7 days
  let allEvents = [];
  for (let page = 1; page <= 3; page++) {
    const events = await githubGet(
      `/users/${USERNAME}/events?per_page=100&page=${page}`,
    );
    if (!events?.length) break;
    allEvents = allEvents.concat(events);
    const oldest = events[events.length - 1];
    if (oldest?.created_at < weekAgoStr) break;
  }

  const pushEvents = allEvents.filter(
    (e) => e.type === "PushEvent" && e.created_at >= weekAgoStr + "T00:00:00Z",
  );

  console.log(`Found ${pushEvents.length} push events`);

  // Map: repoFullName -> { sha -> { date, isPrivate } }
  const commitsByRepo = {};

  for (const event of pushEvents) {
    const repoName = event.repo.name; // "owner/repo"
    if (!commitsByRepo[repoName]) {
      commitsByRepo[repoName] = {
        commits: new Map(),
        isPrivate: !event.public,
      };
    }
    for (const commit of event.payload.commits || []) {
      commitsByRepo[repoName].commits.set(
        commit.sha,
        event.created_at.split("T")[0],
      );
    }
  }

  // Fetch stats per commit
  // byDay: { date: { repoName: { additions, deletions } } }
  const byDay = {};

  for (const [repoFullName, { commits }] of Object.entries(commitsByRepo)) {
    const [owner, repo] = repoFullName.split("/");
    console.log(`  ${repoFullName}: ${commits.size} commits`);

    for (const [sha, date] of commits) {
      const stats = await getCommitStats(owner, repo, sha);
      if (!byDay[date]) byDay[date] = {};
      if (!byDay[date][repoFullName])
        byDay[date][repoFullName] = { additions: 0, deletions: 0 };
      byDay[date][repoFullName].additions += stats.additions;
      byDay[date][repoFullName].deletions += stats.deletions;
      await sleep(80); // gentle on the API
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
    commitsByRepo[repoFullName]?.isPrivate
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
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', Courier, monospace;
      background: #0d0d0d;
      color: #d4d4d4;
      min-height: 100vh;
      padding: 56px 24px 80px;
    }
    .wrap { max-width: 480px; margin: 0 auto; }
    .eyebrow { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #444; margin-bottom: 10px; }
    .hero-num { font-size: 80px; font-weight: 700; color: #fff; line-height: 1; }
    .hero-sub { font-size: 13px; color: #555; margin-top: 6px; }
    .section { margin-top: 48px; }
    .section-head {
      font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
      color: #383838; border-bottom: 1px solid #1c1c1c; padding-bottom: 8px; margin-bottom: 4px;
    }
    .row {
      display: flex; justify-content: space-between; align-items: baseline;
      padding: 9px 0; border-bottom: 1px solid #161616;
    }
    .row:last-child { border-bottom: none; }
    .label { font-size: 13px; color: #888; }
    .val { font-size: 13px; color: #4ade80; font-weight: 700; }
    .week-num { font-size: 36px; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .empty { font-size: 13px; color: #2a2a2a; padding: 12px 0; }
    .permalink { margin-top: 56px; font-size: 11px; }
    .permalink a { color: #333; text-decoration: none; border-bottom: 1px solid #222; }
    .permalink a:hover { color: #555; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">${todayStr}</div>
    <div class="hero-num">${todayTotal > 0 ? "+" + fmt(todayTotal) : "0"}</div>
    <div class="hero-sub">lines shipped today</div>

    <div class="section">
      <div class="section-head">today by project</div>
      ${repoList(todayEntries, displayName)}
    </div>

    <div class="section">
      <div class="section-head">this week</div>
      <div class="week-num">+${fmt(weekTotal)}</div>
      <div class="hero-sub" style="margin-bottom:20px">lines total</div>
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
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', Courier, monospace;
      background: #0d0d0d;
      color: #d4d4d4;
      min-height: 100vh;
      padding: 56px 24px 80px;
    }
    .wrap { max-width: 480px; margin: 0 auto; }
    .eyebrow { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #444; margin-bottom: 10px; }
    .hero-num { font-size: 80px; font-weight: 700; color: #fff; line-height: 1; }
    .hero-sub { font-size: 13px; color: #555; margin-top: 6px; }
    .section { margin-top: 48px; }
    .section-head {
      font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
      color: #383838; border-bottom: 1px solid #1c1c1c; padding-bottom: 8px; margin-bottom: 4px;
    }
    .row {
      display: flex; justify-content: space-between; align-items: baseline;
      padding: 9px 0; border-bottom: 1px solid #161616;
    }
    .row:last-child { border-bottom: none; }
    .label { font-size: 13px; color: #888; }
    .val { font-size: 13px; color: #4ade80; font-weight: 700; }
    .empty { font-size: 13px; color: #2a2a2a; padding: 12px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">${weekLabel}</div>
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
