import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

dotenv.config();

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const RENDER_KEY = process.env.AITL_RENDERER_KEY;
const IMAGE_ACCESS_KEY = process.env.AITL_IMAGE_ACCESS_KEY || RENDER_KEY;
const VIDEO_ACCESS_KEY = process.env.AITL_VIDEO_ACCESS_KEY || IMAGE_ACCESS_KEY || RENDER_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || "aitl-renders";
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

const AIRTABLE_BASE_ID = "app47YuxOKMw8vkCj";
const AIRTABLE_TABLE_NAME = "AI Tool Radar";
const AIRTABLE_TABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

const WIDTH = 1080;
const HEIGHT = 1350;

const r2Client =
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY
        }
      })
    : null;

const DEFAULT_COPY = {
  hookA: "I thought Facebook was dead.",
  hookB: "ChatGPT proved me wrong.",
  falseBelief: "Facebook has no reach anymore.",
  reframeLine: "That was not the real problem.",
  proofPrompt:
    "What content still grows on Facebook, and how would you build a repeatable posting strategy around emotion, shares, and comments?",
  proofBullets: [
    "Emotion-first posts.",
    "Shareable opinions.",
    "Repeatable formats.",
    "Content people argue with, save, or send."
  ],
  proofNumber: "656K followers later...",
  proofContext: "The platform was not dead.",
  proofLine: "My angle was.",
  useBullets: [
    "Testing assumptions",
    "Finding better angles",
    "Turning vague ideas into repeatable formats"
  ],
  skipBullets: [
    "You use generic prompts",
    "You expect it to do the thinking for you"
  ],
  takeaway:
    "Before you quit a platform, test the angle.\nBad content makes good platforms look dead.\nSave this if you’re building with AI tools."
};

function requireServerAuth(req, res, next) {
  if (!RENDER_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Server missing AITL_RENDERER_KEY"
    });
  }

  const suppliedKey = req.headers["x-render-key"];

  if (!suppliedKey || suppliedKey !== RENDER_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized renderer request"
    });
  }

  next();
}

function requireImageAccess(req, res, next) {
  const suppliedKey = req.query.key;

  if (!IMAGE_ACCESS_KEY || suppliedKey !== IMAGE_ACCESS_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized image request"
    });
  }

  next();
}

function cleanText(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).join("\n");
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function cleanBullets(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item)).filter(Boolean).slice(0, 5);
  }

  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\n|;/)
      .map((item) => item.replace(/^[-•\d.)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 5);
  }

  return fallback;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function hardLimitText(value, maxChars) {
  const text = cleanText(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}…`;
}

function wrapLine(line, maxChars) {
  const words = String(line).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;

    if (test.length <= maxChars) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function wrapText(text, maxChars, maxLines = 99) {
  const lines = String(text)
    .split("\n")
    .flatMap((line) => wrapLine(line, maxChars));

  if (lines.length <= maxLines) return lines;

  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = hardLimitText(clipped[maxLines - 1], maxChars - 1);
  return clipped;
}

function textBlock({
  text,
  x,
  y,
  fontSize = 64,
  weight = 700,
  fill = "#0F172A",
  maxChars = 24,
  maxLines = 99,
  lineHeight = 1.15
}) {
  const lines = wrapText(text, maxChars, maxLines);

  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : fontSize * lineHeight;
      return `<tspan x="${x}" dy="${index === 0 ? 0 : dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  return `
    <text
      x="${x}"
      y="${y}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="${fontSize}"
      font-weight="${weight}"
      fill="${fill}"
    >${tspans}</text>
  `;
}

function bulletList({
  bullets,
  x,
  y,
  fontSize = 38,
  fill = "#111827",
  maxChars = 32,
  maxBulletLines = 2,
  gap = 22
}) {
  let currentY = y;
  let output = "";

  for (const bullet of bullets.slice(0, 5)) {
    const wrapped = wrapText(bullet, maxChars, maxBulletLines);
    const bulletHeight = wrapped.length * fontSize * 1.1 + gap;

    output += `
      <circle cx="${x}" cy="${currentY - fontSize * 0.32}" r="8" fill="#111827"/>
      ${textBlock({
        text: wrapped.join("\n"),
        x: x + 30,
        y: currentY,
        fontSize,
        weight: 700,
        fill,
        maxChars,
        maxLines: maxBulletLines,
        lineHeight: 1.1
      })}
    `;

    currentY += bulletHeight;
  }

  return output;
}

function shell({ eyebrow, slideNumber, bodySvg }) {
  return `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#F8FAFC"/>
          <stop offset="50%" stop-color="#EEF2FF"/>
          <stop offset="100%" stop-color="#FDF2F8"/>
        </linearGradient>

        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#111827" flood-opacity="0.12"/>
        </filter>
      </defs>

      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>

      <circle cx="960" cy="120" r="210" fill="#DBEAFE" opacity="0.8"/>
      <circle cx="88" cy="1218" r="230" fill="#FCE7F3" opacity="0.75"/>
      <circle cx="970" cy="1260" r="190" fill="#DCFCE7" opacity="0.55"/>

      <rect x="72" y="72" width="936" height="1206" rx="56" fill="#FFFFFF" filter="url(#shadow)"/>

      <rect x="112" y="112" width="276" height="48" rx="24" fill="#111827"/>
      <text x="250" y="144" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="800" fill="#FFFFFF" letter-spacing="1.5">
        AI TOOL MYTHBUSTER
      </text>

      <text x="936" y="145" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="800" fill="#94A3B8">
        ${escapeXml(slideNumber)}
      </text>

      ${
        eyebrow
          ? `<text x="112" y="230" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="800" fill="#64748B" letter-spacing="1.2">${escapeXml(eyebrow)}</text>`
          : ""
      }

      ${bodySvg}

      <text x="112" y="1218" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="800" fill="#94A3B8">
        AI Tool Logbook
      </text>
    </svg>
  `;
}

function normalizeSource(source = {}) {
  return {
    hookA: cleanText(source.hookA, DEFAULT_COPY.hookA),
    hookB: cleanText(source.hookB, DEFAULT_COPY.hookB),
    falseBelief: cleanText(source.falseBelief, DEFAULT_COPY.falseBelief),
    reframeLine: cleanText(source.reframeLine, DEFAULT_COPY.reframeLine),
    proofPrompt: cleanText(source.proofPrompt, DEFAULT_COPY.proofPrompt),
    proofBullets: cleanBullets(source.proofBullets, DEFAULT_COPY.proofBullets),
    proofNumber: cleanText(source.proofNumber, DEFAULT_COPY.proofNumber),
    proofContext: cleanText(source.proofContext, DEFAULT_COPY.proofContext),
    proofLine: cleanText(source.proofLine, DEFAULT_COPY.proofLine),
    useBullets: cleanBullets(source.useBullets, DEFAULT_COPY.useBullets),
    skipBullets: cleanBullets(source.skipBullets, DEFAULT_COPY.skipBullets),
    takeaway: cleanText(source.takeaway, DEFAULT_COPY.takeaway),
    caption: cleanText(source.caption, "")
  };
}

function buildSlides(sourceInput = {}) {
  const copy = normalizeSource(sourceInput);
  const slides = [];

  slides.push(
    shell({
      eyebrow: "HOOK",
      slideNumber: "01 / 07",
      bodySvg: `
        ${textBlock({
          text: hardLimitText(copy.hookA, 125),
          x: 112,
          y: 345,
          fontSize: 58,
          weight: 900,
          maxChars: 22,
          maxLines: 5,
          lineHeight: 1.08
        })}
        ${textBlock({
          text: hardLimitText(copy.hookB, 82),
          x: 112,
          y: 735,
          fontSize: 48,
          weight: 900,
          fill: "#2563EB",
          maxChars: 24,
          maxLines: 4,
          lineHeight: 1.08
        })}
        <rect x="112" y="1010" width="730" height="82" rx="41" fill="#EFF6FF"/>
        ${textBlock({
          text: "The platform was not the problem.",
          x: 154,
          y: 1064,
          fontSize: 34,
          weight: 800,
          fill: "#1D4ED8",
          maxChars: 36,
          maxLines: 1
        })}
      `
    })
  );

  slides.push(
    shell({
      eyebrow: "FALSE BELIEF",
      slideNumber: "02 / 07",
      bodySvg: `
        ${textBlock({
          text: "The bad assumption:",
          x: 112,
          y: 365,
          fontSize: 54,
          weight: 900,
          maxChars: 24,
          maxLines: 2
        })}
        <rect x="112" y="455" width="856" height="360" rx="36" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="4"/>
        ${textBlock({
          text: `“${hardLimitText(copy.falseBelief, 150)}”`,
          x: 154,
          y: 560,
          fontSize: 48,
          weight: 900,
          fill: "#DC2626",
          maxChars: 28,
          maxLines: 5,
          lineHeight: 1.08
        })}
        ${textBlock({
          text: hardLimitText(copy.reframeLine, 120),
          x: 112,
          y: 930,
          fontSize: 50,
          weight: 900,
          fill: "#111827",
          maxChars: 27,
          maxLines: 3,
          lineHeight: 1.1
        })}
      `
    })
  );

  slides.push(
    shell({
      eyebrow: "PROMPT",
      slideNumber: "03 / 07",
      bodySvg: `
        ${textBlock({
          text: "So I asked:",
          x: 112,
          y: 350,
          fontSize: 54,
          weight: 900,
          maxChars: 24,
          maxLines: 1
        })}
        <rect x="112" y="430" width="856" height="610" rx="38" fill="#111827"/>
        ${textBlock({
          text: `“${hardLimitText(copy.proofPrompt, 260)}”`,
          x: 158,
          y: 535,
          fontSize: 38,
          weight: 750,
          fill: "#FFFFFF",
          maxChars: 36,
          maxLines: 9,
          lineHeight: 1.18
        })}
      `
    })
  );

  slides.push(
    shell({
      eyebrow: "OUTPUT",
      slideNumber: "04 / 07",
      bodySvg: `
        ${textBlock({
          text: "The answer was simple:",
          x: 112,
          y: 340,
          fontSize: 54,
          weight: 900,
          maxChars: 25,
          maxLines: 2
        })}
        ${bulletList({
          bullets: copy.proofBullets,
          x: 132,
          y: 505,
          fontSize: 42,
          fill: "#111827",
          maxChars: 32,
          maxBulletLines: 3,
          gap: 28
        })}
      `
    })
  );

  slides.push(
    shell({
      eyebrow: "PROOF",
      slideNumber: "05 / 07",
      bodySvg: `
        ${textBlock({
          text: hardLimitText(copy.proofNumber, 50),
          x: 112,
          y: 405,
          fontSize: 74,
          weight: 950,
          fill: "#16A34A",
          maxChars: 18,
          maxLines: 2,
          lineHeight: 1.05
        })}
        <rect x="112" y="660" width="856" height="370" rx="38" fill="#F0FDF4" stroke="#86EFAC" stroke-width="4"/>
        ${textBlock({
          text: hardLimitText(copy.proofContext, 115),
          x: 154,
          y: 770,
          fontSize: 44,
          weight: 900,
          fill: "#166534",
          maxChars: 30,
          maxLines: 3,
          lineHeight: 1.1
        })}
        ${textBlock({
          text: hardLimitText(copy.proofLine, 110),
          x: 154,
          y: 930,
          fontSize: 42,
          weight: 950,
          fill: "#111827",
          maxChars: 30,
          maxLines: 3,
          lineHeight: 1.1
        })}
      `
    })
  );

  slides.push(
    shell({
      eyebrow: "USE / SKIP",
      slideNumber: "06 / 07",
      bodySvg: `
        <rect x="112" y="300" width="856" height="392" rx="36" fill="#EFF6FF"/>
        ${textBlock({
          text: "USE IT IF:",
          x: 154,
          y: 370,
          fontSize: 38,
          weight: 950,
          fill: "#1D4ED8",
          maxChars: 25,
          maxLines: 1
        })}
        ${bulletList({
          bullets: copy.useBullets,
          x: 172,
          y: 465,
          fontSize: 34,
          fill: "#111827",
          maxChars: 36,
          maxBulletLines: 2,
          gap: 18
        })}

        <rect x="112" y="740" width="856" height="330" rx="36" fill="#FEF2F2"/>
        ${textBlock({
          text: "SKIP IT IF:",
          x: 154,
          y: 810,
          fontSize: 38,
          weight: 950,
          fill: "#DC2626",
          maxChars: 25,
          maxLines: 1
        })}
        ${bulletList({
          bullets: copy.skipBullets,
          x: 172,
          y: 905,
          fontSize: 34,
          fill: "#111827",
          maxChars: 38,
          maxBulletLines: 2,
          gap: 18
        })}
      `
    })
  );

  slides.push(
    shell({
      eyebrow: "SAVE-WORTHY TAKEAWAY",
      slideNumber: "07 / 07",
      bodySvg: `
        ${textBlock({
          text: hardLimitText(copy.takeaway, 190),
          x: 112,
          y: 360,
          fontSize: 52,
          weight: 950,
          fill: "#111827",
          maxChars: 27,
          maxLines: 7,
          lineHeight: 1.12
        })}
        <rect x="112" y="1035" width="690" height="82" rx="41" fill="#111827"/>
        ${textBlock({
          text: "Save this if you build with AI.",
          x: 154,
          y: 1089,
          fontSize: 34,
          weight: 900,
          fill: "#FFFFFF",
          maxChars: 34,
          maxLines: 1
        })}
      `
    })
  );

  const caption =
    copy.caption ||
    `${copy.hookA} ${copy.hookB}\n\nUse AI tools to test assumptions, sharpen positioning, and turn vague ideas into repeatable formats.\n\nSave this if you’re building with AI tools.`;

  return { slides, caption };
}

function sourceFromAirtableFields(fields = {}) {
  return {
    hookA: fields["AITL Carousel Hook A"],
    hookB: fields["AITL Carousel Hook B"],
    falseBelief: fields["AITL False Belief"],
    reframeLine: fields["AITL Reframe Line"],
    proofPrompt: fields["AITL Proof Prompt"],
    proofBullets: fields["AITL Proof Bullets"],
    proofNumber: fields["AITL Proof Number"],
    proofContext: fields["AITL Proof Context"],
    proofLine: fields["AITL Proof Line"],
    useBullets: fields["AITL Use Bullets"],
    skipBullets: fields["AITL Skip Bullets"],
    takeaway: fields["AITL Takeaway"],
    caption: fields["AITL Carousel Caption"]
  };
}

function getPublicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

async function fetchAirtableRecord(recordId) {
  if (!AIRTABLE_TOKEN) {
    throw new Error("Server missing AIRTABLE_PERSONAL_ACCESS_TOKEN");
  }

  const response = await fetch(`${AIRTABLE_TABLE_URL}/${recordId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Airtable fetch failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function svgToPngBuffer(svg) {
  return sharp(Buffer.from(svg))
    .png({ quality: 100, compressionLevel: 9 })
    .toBuffer();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static path is missing."));
      return;
    }

    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
    });
  });
}

async function renderMp4ForRecord(recordId) {
  const record = await fetchAirtableRecord(recordId);
  const source = sourceFromAirtableFields(record.fields || {});
  const { slides } = buildSlides(source);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `aitl-video-${recordId}-`));
  const outputPath = path.join(workDir, "carousel.mp4");
  const listPath = path.join(workDir, "slides.txt");

  const slidePaths = [];

  for (let index = 0; index < slides.length; index++) {
    const pngBuffer = await svgToPngBuffer(slides[index]);
    const slidePath = path.join(workDir, `slide_${String(index + 1).padStart(3, "0")}.png`);
    await fs.writeFile(slidePath, pngBuffer);
    slidePaths.push(slidePath);
  }

  let concatText = "";

  for (let index = 0; index < slidePaths.length; index++) {
    const duration = index === slidePaths.length - 1 ? 3.2 : 2.8;
    concatText += `file '${slidePaths[index].replaceAll("'", "'\\''")}'\n`;
    concatText += `duration ${duration}\n`;
  }

  concatText += `file '${slidePaths[slidePaths.length - 1].replaceAll("'", "'\\''")}'\n`;

  await fs.writeFile(listPath, concatText, "utf8");

  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-movflags",
    "+faststart",
    outputPath
  ]);

  return { workDir, outputPath };
}

async function uploadMp4ToR2(recordId, filePath) {
  if (!r2Client) {
    throw new Error("R2 client not configured. Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.");
  }

  if (!R2_PUBLIC_BASE_URL) {
    throw new Error("Missing R2_PUBLIC_BASE_URL.");
  }

  const objectKey = `aitl-carousel/${recordId}/carousel.mp4`;
  const fileBuffer = await fs.readFile(filePath);

  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: objectKey,
      Body: fileBuffer,
      ContentType: "video/mp4",
      CacheControl: "public, max-age=31536000"
    })
  );

  return `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${objectKey}`;
}

async function safeCleanup(dirPath) {
  if (!dirPath || !dirPath.includes("aitl-video-")) return;

  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.error("Cleanup failed:", error);
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Tool Logbook Automated Carousel Renderer",
    storage: "r2",
    r2Configured: Boolean(r2Client && R2_PUBLIC_BASE_URL && R2_BUCKET),
    bucket: R2_BUCKET,
    cloudinary: false,
    layout: "safe-text-v2",
    video: "ffmpeg-r2-mp4-v2",
    ffmpegPath: Boolean(ffmpegPath),
    timestamp: new Date().toISOString()
  });
});

app.post("/render/aitl-carousel", requireServerAuth, async (req, res) => {
  try {
    const recordId = cleanText(req.body?.recordId);

    if (!recordId) {
      return res.status(400).json({ ok: false, error: "Missing recordId" });
    }

    const baseUrl = getPublicBaseUrl(req);
    const { caption } = buildSlides(req.body?.source || {});

    const slideUrls = [1, 2, 3, 4, 5, 6, 7].map((slideNumber) => {
      return `${baseUrl}/slides/${recordId}/${slideNumber}.png?key=${encodeURIComponent(IMAGE_ACCESS_KEY)}`;
    });

    return res.json({
      ok: true,
      renderId: `aitl_${recordId}`,
      style: "AI Tool MythBuster",
      slideUrls,
      caption,
      notes: "Generated 7 live PNG slide URLs from renderer service. Safe-text layout v2."
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Carousel URL generation failed",
      message: error?.message || String(error)
    });
  }
});

app.post("/render/aitl-carousel-video", requireServerAuth, async (req, res) => {
  let workDir;

  try {
    const recordId = cleanText(req.body?.recordId);

    if (!recordId) {
      return res.status(400).json({ ok: false, error: "Missing recordId" });
    }

    const rendered = await renderMp4ForRecord(recordId);
    workDir = rendered.workDir;

    const videoUrl = await uploadMp4ToR2(recordId, rendered.outputPath);
    const baseUrl = getPublicBaseUrl(req);

    await safeCleanup(workDir);

    return res.json({
      ok: true,
      renderId: `aitl_video_${recordId}`,
      videoUrl,
      thumbnailUrl: `${baseUrl}/slides/${recordId}/1.png?key=${encodeURIComponent(IMAGE_ACCESS_KEY)}`,
      format: "mp4",
      storage: "r2",
      width: WIDTH,
      height: HEIGHT,
      durationSeconds: 20,
      notes: "Generated MP4, uploaded to Cloudflare R2, and returned permanent playable video URL."
    });
  } catch (error) {
    if (workDir) await safeCleanup(workDir);

    return res.status(500).json({
      ok: false,
      error: "Video render/upload failed",
      message: error?.message || String(error)
    });
  }
});

app.get("/slides/:recordId/:slideNumber.png", requireImageAccess, async (req, res) => {
  try {
    const recordId = req.params.recordId;
    const slideNumber = Number(req.params.slideNumber);

    if (!recordId || !Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > 7) {
      return res.status(400).json({ ok: false, error: "Invalid slide URL" });
    }

    const record = await fetchAirtableRecord(recordId);
    const source = sourceFromAirtableFields(record.fields || {});
    const { slides } = buildSlides(source);

    const pngBuffer = await svgToPngBuffer(slides[slideNumber - 1]);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");

    return res.send(pngBuffer);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Slide render failed",
      message: error?.message || String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI Tool Logbook carousel renderer running on port ${PORT}`);
});
