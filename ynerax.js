const https = require("https");
const fs = require("fs");
const readline = require("readline");
const crypto = require("crypto");
const zlib = require("zlib");

// ── CONFIG ──────────────────────────────────────────────
const REF_CODE = "DXUGYQ";
const YNERAX_BASE = "www.ynerax.one";
const TWITTER_API = "api.x.com";
const TWITTER_WEB = "x.com";

const CLIENT_ID = "MGFtaXJLN2xSQ2xpRUY0dDdSc2I6MTpjaQ";
const REDIRECT_URI = "https://puvmgctzzvbxmvnoiahm.supabase.co/auth/v1/callback";
const REDIRECT_TO = "https://www.ynerax.one/auth/callback";
const SCOPE = "users.email tweet.read users.read offline.access";

// ── UTILS ────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const encoding = res.headers["content-encoding"];
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const decompress = (data) => {
          try {
            if (encoding === "gzip") return zlib.gunzipSync(data).toString("utf-8");
            if (encoding === "br") return zlib.brotliDecompressSync(data).toString("utf-8");
            if (encoding === "deflate") return zlib.inflateSync(data).toString("utf-8");
          } catch (_) {}
          return data.toString("utf-8");
        };
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: decompress(buf),
        });
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function parseCookies(setCookieHeaders) {
  const cookies = {};
  if (!setCookieHeaders) return cookies;
  const arr = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  for (const c of arr) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = val;
    }
  }
  return cookies;
}

function cookieStr(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── LOAD AKUN ────────────────────────────────────────────
function loadAccounts(filePath) {
  const lines = fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim());
  const accounts = [];
  let i = 0;
  while (i < lines.length) {
    // skip blank
    while (i < lines.length && lines[i] === "") i++;
    if (i >= lines.length) break;
    const authToken = lines[i++];
    while (i < lines.length && lines[i] === "") i++;
    if (i >= lines.length) break;
    const ct0 = lines[i++];
    accounts.push({ authToken, ct0 });
  }
  return accounts;
}

// ── STEP 1: GET ynerax home dengan ref ──────────────────
async function getYneraxHome(cookies) {
  const res = await request({
    hostname: YNERAX_BASE,
    path: `/?ref=${REF_CODE}`,
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      Cookie: cookieStr(cookies),
    },
  });

  let allCookies = { ...cookies, ...parseCookies(res.headers["set-cookie"]) };

  // Follow 307 redirect ke / biar ref ke-register server-side
  if ((res.status === 307 || res.status === 302) && res.headers["location"]) {
    const loc = res.headers["location"];
    const path = loc.startsWith("http") ? new URL(loc).pathname + new URL(loc).search : loc;
    const res2 = await request({
      hostname: YNERAX_BASE,
      path,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        Cookie: cookieStr(allCookies),
        Referer: `https://${YNERAX_BASE}/?ref=${REF_CODE}`,
      },
    });
    allCookies = { ...allCookies, ...parseCookies(res2.headers["set-cookie"]) };
  }

  const newCookies = allCookies;
  // Hardcode ref_code kalau ga ke-set dari server
  if (!newCookies.ref_code) {
    console.log(`  ⚠ ref_code tidak di-set server, hardcode manual`);
    newCookies.ref_code = REF_CODE;
  } else {
    console.log(`  ✓ ref_code dari server: ${newCookies.ref_code}`);
  }
  return newCookies;
}

// ── STEP 2: GET auth_code dari Twitter API ───────────────
async function getAuthCode(authToken, ct0, codeChallenge, state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_to: REDIRECT_TO,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    state,
  });

  const cookies = { auth_token: authToken, ct0 };

  // Pakai API endpoint langsung, bukan HTML page
  const res = await request({
    hostname: TWITTER_API,
    path: `/2/oauth2/authorize?${params.toString()}`,
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      Accept: "application/json",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      Authorization: `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
      Cookie: cookieStr(cookies),
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Client-Language": "id",
      Referer: "https://x.com/",
    },
  });

  const newCookies = parseCookies(res.headers["set-cookie"]);
  let body = res.body;
  try { body = JSON.parse(body); } catch (_) {}

  return {
    status: res.status,
    cookies: { ...cookies, ...newCookies },
    body,
  };
}

// ── STEP 3: POST approve OAuth ───────────────────────────
async function approveOAuth(authToken, ct0, authCode, twitterCookies) {
  const formData = new URLSearchParams({
    approval: "true",
    code: authCode,
    consent_flow: "web_consent",
  }).toString();

  const res = await request(
    {
      hostname: TWITTER_API,
      path: "/2/oauth2/authorize",
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formData),
        Authorization: `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
        Cookie: cookieStr(twitterCookies),
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes",
        "X-Twitter-Client-Language": "id",
        Referer: "https://x.com/",
        "Accept-Encoding": "gzip, deflate, br, zstd",
      },
    },
    formData
  );

  let body = res.body;
  try { body = JSON.parse(body); } catch (_) {}
  return { status: res.status, body, headers: res.headers };
}

// ── STEP 4: Handle callback ke ynerax ───────────────────
async function handleCallback(callbackUrl, yneraxCookies, maxRedirects = 5) {
  let url = new URL(callbackUrl);
  let cookies = { ...yneraxCookies };
  let lastStatus = 0;

  for (let i = 0; i < maxRedirects; i++) {
    const res = await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        Cookie: cookieStr(cookies),
        Referer: "https://x.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
      },
    });

    const newCookies = parseCookies(res.headers["set-cookie"]);
    if (Object.keys(newCookies).length > 0) {
      console.log(`  [cb step ${i}] set-cookie dari ${url.hostname}: ${Object.keys(newCookies).join(", ")}`);
    }
    cookies = { ...cookies, ...newCookies };
    lastStatus = res.status;

    // Log body selalu untuk debug
    console.log(`  [cb step ${i}] status: ${res.status}, host: ${url.hostname}, body[0:200]: ${(res.body||"").slice(0, 200)}`);

    // Extract Supabase auth token dari body
    if (res.body && res.body.includes("access_token")) {
      const atMatch = res.body.match(/"access_token":"([^"]+)"/);
      const rtMatch = res.body.match(/"refresh_token":"([^"]+)"/);
      if (atMatch && rtMatch) {
        const tokenVal = encodeURIComponent(JSON.stringify({
          access_token: atMatch[1],
          refresh_token: rtMatch[1],
          token_type: "bearer",
        }));
        cookies["sb-puvmgctzzvbxmvnoiahm-auth-token"] = tokenVal;
        console.log(`  [cb step ${i}] ✓ Extracted Supabase auth token dari body`);
      }
    }

    // Cek error exchange
    if (res.headers["location"] && res.headers["location"].includes("exchange_failed")) {
      return { status: res.status, error: "exchange_failed", cookies };
    }

    // Follow redirect — termasuk ke ynerax.one/auth/callback
    if (res.headers["location"]) {
      const loc = res.headers["location"];
      url = loc.startsWith("http") ? new URL(loc) : new URL(loc, `https://${url.hostname}`);
      console.log(`  [cb step ${i}] redirect -> ${url.href}`);
      await sleep(500);
      continue;
    }

    return { status: res.status, cookies, location: res.headers["location"] };
  }

  return { status: lastStatus, cookies };
}

// ── STEP 5: GET welcome ──────────────────────────────────
async function getWelcome(yneraxCookies) {
  const res = await request({
    hostname: YNERAX_BASE,
    path: "/?welcome=1",
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      Cookie: cookieStr(yneraxCookies),
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
    },
  });

  return { status: res.status, body: res.body };
}

// ── EXTRACT code dari redirect_uri response ───────────────
function extractCodeFromBody(body) {
  // body dari POST approve biasanya JSON dengan redirect_uri
  if (body && body.redirect_uri) {
    const url = new URL(body.redirect_uri);
    return {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      callbackUrl: body.redirect_uri,
    };
  }
  return null;
}

// ── STEP 6: Task follow @yneraxone ──────────────────────
// PENTING: Next-Action ID bukan UUID biasa — harus intercept dari DevTools.
// Buka ynerax.one, klik task follow, cari request POST ke "/" dengan
// header "Next-Action", salin value-nya ke sini (biasanya 40-64 char hex).
const TASK_ID = "ebd461f1-0cbc-4117-bc72-a19207e29742"; // ← GANTI dengan ID dari DevTools

async function followTwitterUser(authToken, ct0) {
  // Follow langsung via screen_name, ga perlu user ID sendiri
  const followBody = new URLSearchParams({ screen_name: "yneraxone" }).toString();
  const followRes = await request({
    hostname: TWITTER_API,
    path: "/1.1/friendships/create.json",
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(followBody),
      Authorization: `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
      Cookie: `auth_token=${authToken}; ct0=${ct0}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes",
      Referer: "https://x.com/",
    },
  }, followBody);

  let followResBody = followRes.body;
  try { followResBody = JSON.parse(followResBody); } catch (_) {}
  return { ok: followRes.status === 200, body: followResBody };
}

async function discoverTaskId(yneraxCookies, label) {
  // Coba ambil Next-Action ID dari halaman ynerax langsung
  const res = await request({
    hostname: YNERAX_BASE,
    path: "/",
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Cookie: cookieStr(yneraxCookies),
    },
  });

  // Next.js server action IDs: bisa hex 40+ char atau UUID format
  const hexMatches = res.body.match(/"([0-9a-f]{40,64})"/g) || [];
  const uuidMatches = res.body.match(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g) || [];
  const allMatches = [...hexMatches, ...uuidMatches];
  if (allMatches.length > 0) {
    const ids = [...new Set(allMatches.map(m => m.replace(/"/g, "")))];
    console.log(`${label} 🔍 Kandidat Task ID dari page: ${ids.slice(0, 3).join(", ")}`);
    return ids[0];
  }

  console.log(`${label} ⚠ Tidak bisa auto-discover Task ID — pakai TASK_ID dari config`);
  return null;
}

async function doTask(authToken, ct0, yneraxCookies, label) {
  // Follow @yneraxone dulu
  console.log(`${label} Follow @yneraxone...`);
  const followRes = await followTwitterUser(authToken, ct0);
  if (!followRes.ok) {
    console.log(`${label} ⚠ Follow gagal: ${JSON.stringify(followRes.body ?? followRes.error ?? "unknown").slice(0, 100)}`);
  } else {
    console.log(`${label} ✓ Followed @yneraxone`);
  }

  await sleep(2000);

  // Auto-discover task ID jika TASK_ID masih UUID placeholder
  let effectiveTaskId = TASK_ID;
  if (TASK_ID.includes("-")) {
    const discovered = await discoverTaskId(yneraxCookies, label);
    if (discovered) {
      effectiveTaskId = discovered;
      console.log(`${label} 🔍 Pakai auto-discovered Task ID: ${effectiveTaskId}`);
    } else {
      console.log(`${label} ⚠ TASK_ID masih UUID — kemungkinan besar gagal. Intercept dari DevTools dulu.`);
    }
  }

  const body = JSON.stringify([effectiveTaskId]);

  // Klik task
  await request({
    hostname: YNERAX_BASE,
    path: "/",
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      Accept: "text/x-component",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Content-Type": "text/plain;charset=UTF-8",
      "Content-Length": Buffer.byteLength(body),
      Cookie: cookieStr(yneraxCookies),
      Referer: "https://www.ynerax.one/",
      "Next-Action": effectiveTaskId,
    },
  }, body);

  await sleep(5000);

  // Verify task
  const verifyRes = await request({
    hostname: YNERAX_BASE,
    path: "/",
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      Accept: "text/x-component",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Content-Type": "text/plain;charset=UTF-8",
      "Content-Length": Buffer.byteLength(body),
      Cookie: cookieStr(yneraxCookies),
      Referer: "https://www.ynerax.one/",
      "Next-Action": effectiveTaskId,
    },
  }, body);

  const verifyBody = verifyRes.body;
  console.log(`${label} Debug cookies keys: ${Object.keys(yneraxCookies).join(", ")}`);
  console.log(`${label} Debug verify raw: ${verifyBody.slice(0, 200)}`);
  const match = verifyBody.match(/\{"ok":true[^}]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.ok && parsed.reward) {
        console.log(`${label} ✅ Task selesai! Reward: ${parsed.reward}, Entries: ${parsed.entries}`);
        return true;
      }
    } catch (_) {}
  }

  if (verifyBody.includes('"ok":true')) {
    console.log(`${label} ✅ Task selesai!`);
    return true;
  }

  console.log(`${label} ⚠ Task response tidak jelas`);
  return false;
}

// ── MAIN FLOW PER AKUN ───────────────────────────────────
async function connectAccount(account, index) {
  const { authToken, ct0 } = account;
  const label = `[Akun ${index + 1}]`;

  try {
    console.log(`\n${label} Mulai connect...`);

    // Step 1: Hit ynerax home dengan ref
    console.log(`${label} [1/5] Hit ynerax home dengan ref...`);
    let yneraxCookies = await getYneraxHome({});
    console.log(
      `${label} ✓ ref_code cookie: ${yneraxCookies.ref_code || "tidak ada (cek manual)"}`
    );

    // Generate PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    // Step 2: Get auth code dari Twitter API
    console.log(`${label} [2/5] Get auth code dari Twitter API...`);
    const authRes = await getAuthCode(authToken, ct0, codeChallenge, state);

    if (authRes.status !== 200) {
      console.log(`${label} ✗ Gagal get auth code, status: ${authRes.status}`);
      console.log(`${label} Body:`, JSON.stringify(authRes.body).slice(0, 300));
      fs.writeFileSync(`debug_auth_${index}.json`, JSON.stringify(authRes.body, null, 2));
      return false;
    }

    // auth_code ada di body.auth_code
    const authCode = authRes.body?.auth_code;
    if (!authCode) {
      console.log(`${label} ✗ Tidak bisa extract auth_code`);
      fs.writeFileSync(`debug_auth_${index}.json`, JSON.stringify(authRes.body, null, 2));
      console.log(`${label} Debug disimpan ke debug_auth_${index}.json`);
      return false;
    }
    console.log(`${label} ✓ Auth code: ${authCode.slice(0, 20)}...`);

    // Step 3: Approve OAuth
    console.log(`${label} [3/5] Approve OAuth...`);
    const approveRes = await approveOAuth(
      authToken,
      ct0,
      authCode,
      authRes.cookies
    );

    if (approveRes.status !== 200) {
      console.log(
        `${label} ✗ Approve gagal, status: ${approveRes.status}`
      );
      console.log(`${label} Body:`, JSON.stringify(approveRes.body).slice(0, 200));
      return false;
    }

    const extracted = extractCodeFromBody(approveRes.body);
    if (!extracted) {
      console.log(`${label} ✗ Tidak bisa extract callback URL`);
      console.log(`${label} Response:`, JSON.stringify(approveRes.body).slice(0, 300));
      return false;
    }
    console.log(`${label} ✓ Dapat callback URL`);

    // Step 4: Hit callback ynerax
    console.log(`${label} [4/5] Handle callback ynerax...`);
    // Supabase SSR butuh code_verifier dari cookie untuk exchange token server-side
    yneraxCookies["sb-puvmgctzzvbxmvnoiahm-auth-token-flows-code-verifier"] = codeVerifier;
    const cbRes = await handleCallback(extracted.callbackUrl, yneraxCookies);

    if (cbRes.error === "exchange_failed") {
      console.log(`${label} ✗ Exchange failed (rate limit Twitter) — coba lagi nanti`);
      return false;
    }
    console.log(`${label} ✓ Callback status: ${cbRes.status}`);

    // Update cookies — preserve ref_code agar tidak hilang setelah callback
    const savedRefCode = yneraxCookies.ref_code;
    yneraxCookies = cbRes.cookies;
    if (savedRefCode && !yneraxCookies.ref_code) {
      yneraxCookies.ref_code = savedRefCode;
    }

    // Step 5: Hit welcome
    console.log(`${label} [5/5] Hit welcome page...`);
    console.log(`${label} 🔍 Cookies setelah callback: ${Object.keys(yneraxCookies).join(", ")}`);
    console.log(`${label} 🔍 ref_code sebelum welcome: ${yneraxCookies.ref_code || "TIDAK ADA ⚠"}`);
    await sleep(1000);
    const welcomeRes = await getWelcome(yneraxCookies);

    if (welcomeRes.status === 200) {
      console.log(`${label} ✅ Connect berhasil`);
    } else if (welcomeRes.status === 307 || welcomeRes.status === 303) {
      console.log(`${label} ✅ Connect berhasil (redirect dashboard)`);
    } else {
      console.log(`${label} ⚠ Welcome status: ${welcomeRes.status}`);
      return false;
    }

    // Step 6: Task follow
    console.log(`${label} [6/6] Ngerjain task follow...`);
    await sleep(2000);
    const taskOk = await doTask(authToken, ct0, yneraxCookies, label);

    return taskOk;
  } catch (err) {
    console.log(`${label} ✗ Error: ${err.message}`);
    return false;
  }
}

// ── MENU INTERAKTIF ──────────────────────────────────────
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((r) => rl.question(q, r));

  console.log("=================================");
  console.log("  Ynerax X Connect Bot");
  console.log(`  Ref: ${REF_CODE}`);
  console.log("=================================");

  const accounts = loadAccounts("akun.txt");
  console.log(`\nTotal akun: ${accounts.length}`);

  console.log("\nPilih mode:");
  console.log("1. 1 akun (pilih nomor)");
  console.log("2. Semua akun");
  console.log("3. Dari akun X sampai selesai");

  const mode = await ask("\nPilihan (1/2/3): ");

  let toProcess = [];

  if (mode === "1") {
    const num = parseInt(await ask(`Nomor akun (1-${accounts.length}): `));
    if (isNaN(num) || num < 1 || num > accounts.length) {
      console.log("Nomor tidak valid");
      rl.close();
      return;
    }
    toProcess = [{ account: accounts[num - 1], index: num - 1 }];
  } else if (mode === "2") {
    toProcess = accounts.map((a, i) => ({ account: a, index: i }));
  } else if (mode === "3") {
    const from = parseInt(await ask(`Dari akun nomor (1-${accounts.length}): `));
    if (isNaN(from) || from < 1 || from > accounts.length) {
      console.log("Nomor tidak valid");
      rl.close();
      return;
    }
    toProcess = accounts
      .slice(from - 1)
      .map((a, i) => ({ account: a, index: from - 1 + i }));
  } else {
    console.log("Pilihan tidak valid");
    rl.close();
    return;
  }

  rl.close();

  const delay = 10000; // 10 detik antar akun
  let sukses = 0;
  let gagal = 0;

  for (const { account, index } of toProcess) {
    const ok = await connectAccount(account, index);
    if (ok) sukses++;
    else gagal++;

    if (toProcess.findIndex(item => item.index === index) < toProcess.length - 1) {
      await sleep(delay);
    }
  }

  console.log("\n=================================");
  console.log(`  Selesai!`);
  console.log(`  ✅ Sukses : ${sukses}`);
  console.log(`  ❌ Gagal  : ${gagal}`);
  console.log("=================================");
}

main();
