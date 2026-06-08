import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const WIDTH = 720;
const HEIGHT = 1280;
const PORT = Number(process.env.PORT || 10000);

const AIRTABLE_TOKEN = process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN || process.env.AIRTABLE_TOKEN || "";
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "app47YuxOKMw8vkCj";
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "AI Tool Radar";
const AIRTABLE_TABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

const SERVER_RENDER_KEY = process.env.SERVER_RENDER_KEY || "aitl_carousel_2026_private_render_key_9041";
const IMAGE_ACCESS_KEY = process.env.IMAGE_ACCESS_KEY || "aitl_carousel_image_access_2026";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "aitl-renders";
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || "";
const R2_PREFIX = "aitl-proof-footage-v2-safe";

const r2Client = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
    })
  : null;

let queueRunning = false;
const renderQueue = [];
const jobHistory = new Map();

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const out = String(value).replace(/\s+/g, " ").trim();
  return out || fallback;
}

function escapeXml(value) {
  return cleanText(value).replace(/[<>&'"]/g, (ch) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  }[ch]));
}

function hardLimitText(value, max = 180) {
  const s = cleanText(value);
  return s.length <= max ? s : `${s.slice(0, max - 1).trim()}…`;
}

function textBlock({
  text,
  x,
  y,
  fontSize = 44,
  weight = 900,
  fill = "#FFFFFF",
  maxChars = 24,
  maxLines = 3,
  lineHeight = 1.12,
  anchor = "start",
  family = "Arial, Helvetica, sans-serif",
  letterSpacing = 0
}) {
  const words = cleanText(text).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.map((l, i) => {
    const yy = y + i * fontSize * lineHeight;
    return `<text x="${x}" y="${yy}" font-family="${family}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${letterSpacing}">${escapeXml(l)}</text>`;
  }).join("\n");
}

function splitOutputLines(value, max = 8) {
  return cleanText(value)
    .split(/\n+/)
    .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 12)
    .slice(0, max);
}

function attachmentUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    return first?.url || first?.thumbnails?.large?.url || first?.thumbnails?.full?.url || "";
  }
  if (typeof value === "object") return value.url || value?.thumbnails?.large?.url || value?.thumbnails?.full?.url || "";
  return "";
}

async function fetchBuffer(url) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function imageToDataUri(url) {
  const buffer = await fetchBuffer(url);
  if (!buffer) return "";
  const png = await sharp(buffer).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function keyArtCover(url) {
  const buffer = await fetchBuffer(url);
  if (!buffer) return null;
  return sharp(buffer).resize(WIDTH, HEIGHT, { fit: "cover", position: "center" }).png().toBuffer();
}

function normalizeSource(fields = {}) {
  const outputExcerpt = cleanText(fields["AITL Proof Output Excerpt"] || fields["AITL Actual Output"] || fields["AITL Test Result"] || fields["AITL Proof Raw Output"], "No output captured yet.");
  const toolName = cleanText(fields["Tool Name"], "ChatGPT / OpenAI API");
  return {
    toolName,
    title: cleanText(fields["Title"], "I tested an AI tool with a real workflow"),
    keyArtUrl: attachmentUrl(fields["AITL Video Key Art"]),
    reactionImageUrl: attachmentUrl(fields["AITL Reaction Image"]),
    metric1Label: cleanText(fields["AITL Proof Metric 1 Label"], "Response time"),
    metric1Value: cleanText(fields["AITL Proof Metric One Value"], "22.24s"),
    metric2Label: cleanText(fields["AITL Proof Metric 2 Label"], "Output length"),
    metric2Value: cleanText(fields["AITL Proof Metric Two Result"], "6651 chars"),
    metric3Label: cleanText(fields["AITL Proof Metric Three Label"], "Usability score"),
    metric3Value: cleanText(fields["AITL Proof Metric Three Result"], "10/10"),
    proofInput: cleanText(fields["AITL Proof Input"] || fields["AITL Messy Input"], "Messy Facebook content framework"),
    proofPrompt: cleanText(fields["AITL Proof Prompt"] || fields["AITL Test Prompt"], "Write a creator workflow test"),
    rawOutput: cleanText(fields["AITL Proof Raw Output"], outputExcerpt),
    outputExcerpt,
    verdict: cleanText(fields["AITL Proof Verdict"] || fields["AITL Honest Verdict"], "Worth testing with a real framework."),
    caption: cleanText(fields["AITL Carousel Caption"], `${toolName} tested with real input and real API output.`)
  };
}

function baseSvg(slideIndex, label = "REAL API TEST") {
  return `
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#020617"/>
        <stop offset="50%" stop-color="#07111F"/>
        <stop offset="100%" stop-color="#050A17"/>
      </linearGradient>
      <linearGradient id="cyanPurple" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#00D9FF"/>
        <stop offset="50%" stop-color="#2563EB"/>
        <stop offset="100%" stop-color="#A855F7"/>
      </linearGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000000" flood-opacity="0.55"/>
      </filter>
      <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="0" stdDeviation="12" flood-color="#38BDF8" flood-opacity="0.85"/>
      </filter>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
    <circle cx="960" cy="350" r="430" fill="#2563EB" opacity="0.20"/>
    <circle cx="130" cy="1540" r="430" fill="#A855F7" opacity="0.18"/>
    <path d="M40 140 C300 70 760 80 1040 130" stroke="#2563EB" stroke-width="3" opacity="0.35" fill="none"/>
    <path d="M70 1640 C360 1560 760 1580 1030 1640" stroke="#A855F7" stroke-width="3" opacity="0.35" fill="none"/>
    <rect x="120" y="48" width="840" height="96" rx="24" fill="#06121F" stroke="#38BDF8" stroke-width="5" filter="url(#glow)"/>
    ${textBlock({ text: "AI TOOL LOGBOOK", x: 540, y: 112, fontSize: 54, weight: 950, fill: "#FFFFFF", maxChars: 22, maxLines: 1, anchor: "middle" })}
    <rect x="602" y="170" width="340" height="64" rx="20" fill="#12091F" stroke="#D946EF" stroke-width="4" filter="url(#shadow)"/>
    ${textBlock({ text: label, x: 772, y: 214, fontSize: 30, weight: 950, fill: "#FFFFFF", maxChars: 18, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: `${String(slideIndex).padStart(2, "0")} / 07`, x: 976, y: 110, fontSize: 24, weight: 900, fill: "#CBD5E1", maxChars: 8, maxLines: 1, anchor: "end" })}
  `;
}

function closeSvg() {
  return "</svg>";
}

function metricCard({ x, y, label, value, color, icon = "●" }) {
  return `
    <rect x="${x}" y="${y}" width="320" height="150" rx="28" fill="#020617" stroke="${color}" stroke-width="4" filter="url(#shadow)"/>
    ${textBlock({ text: icon, x: x + 48, y: y + 92, fontSize: 58, weight: 950, fill: color, maxChars: 2, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: label.toUpperCase(), x: x + 103, y: y + 50, fontSize: 23, weight: 950, fill: "#FFFFFF", maxChars: 18, maxLines: 1 })}
    ${textBlock({ text: value, x: x + 205, y: y + 113, fontSize: 56, weight: 950, fill: "#FFFFFF", maxChars: 12, maxLines: 1, anchor: "middle" })}
  `;
}

async function buildSlides(source) {
  const outputLines = splitOutputLines(source.outputExcerpt || source.rawOutput, 8);
  const reactionData = await imageToDataUri(source.reactionImageUrl);
  const faceSvg = reactionData
    ? `<image href="${reactionData}" x="-170" y="165" width="650" height="1180" preserveAspectRatio="xMidYMid slice" opacity="1"/>
       <rect x="0" y="0" width="470" height="1920" fill="url(#bg)" opacity="0.05"/>`
    : `<rect x="0" y="210" width="430" height="990" rx="40" fill="#06121F" stroke="#38BDF8" stroke-width="4"/>
       ${textBlock({ text: "REACTION IMAGE", x: 215, y: 650, fontSize: 42, weight: 950, fill: "#38BDF8", maxChars: 16, maxLines: 2, anchor: "middle" })}`;

  const slides = [];

  slides.push(`${baseSvg(1, "REAL API TEST")}
    ${faceSvg}
    ${textBlock({ text: "I TESTED", x: 458, y: 432, fontSize: 112, weight: 950, fill: "#FFFFFF", maxChars: 9, maxLines: 1 })}
    ${textBlock({ text: hardLimitText(source.toolName, 26), x: 458, y: 560, fontSize: 78, weight: 950, fill: "#38BDF8", maxChars: 15, maxLines: 2, lineHeight: 1.0 })}
    ${textBlock({ text: "Not a homepage review.", x: 520, y: 828, fontSize: 32, weight: 900, fill: "#FFFFFF", maxChars: 24, maxLines: 1 })}
    ${textBlock({ text: "Real prompt in. Real output out.", x: 520, y: 872, fontSize: 34, weight: 950, fill: "#22D3EE", maxChars: 31, maxLines: 1 })}
    <rect x="430" y="930" width="590" height="430" rx="30" fill="#020617" stroke="#38BDF8" stroke-width="4" filter="url(#shadow)"/>
    <rect x="430" y="930" width="590" height="60" rx="30" fill="#0F172A"/>
    ${textBlock({ text: "OpenAI API", x: 930, y: 972, fontSize: 24, weight: 950, fill: "#FFFFFF", maxChars: 16, maxLines: 1, anchor: "end" })}
    ${textBlock({ text: "PROMPT", x: 466, y: 1045, fontSize: 28, weight: 950, fill: "#22D3EE", maxChars: 10, maxLines: 1 })}
    ${textBlock({ text: hardLimitText(source.proofPrompt, 74), x: 466, y: 1090, fontSize: 27, weight: 800, fill: "#E5E7EB", maxChars: 32, maxLines: 3, family: "Courier New, monospace" })}
    ${textBlock({ text: "RESULT", x: 466, y: 1230, fontSize: 28, weight: 950, fill: "#84CC16", maxChars: 10, maxLines: 1 })}
    ${textBlock({ text: hardLimitText(outputLines[0] || source.outputExcerpt, 95), x: 466, y: 1275, fontSize: 25, weight: 850, fill: "#A3E635", maxChars: 34, maxLines: 3, family: "Courier New, monospace" })}
    ${metricCard({ x: 42, y: 1482, label: source.metric1Label, value: source.metric1Value, color: "#38BDF8", icon: "◷" })}
    ${metricCard({ x: 380, y: 1482, label: source.metric2Label, value: source.metric2Value.replace(" chars",""), color: "#D946EF", icon: "▣" })}
    ${metricCard({ x: 718, y: 1482, label: source.metric3Label, value: source.metric3Value, color: "#FACC15", icon: "☆" })}
  ${closeSvg()}`);

  slides.push(`${baseSvg(2, "PROMPT RECEIPT")}
    ${textBlock({ text: "THE EXACT TEST", x: 90, y: 360, fontSize: 82, weight: 950, fill: "#FFFFFF", maxChars: 18, maxLines: 1 })}
    <rect x="70" y="450" width="940" height="910" rx="36" fill="#020617" stroke="#38BDF8" stroke-width="4" filter="url(#shadow)"/>
    ${textBlock({ text: hardLimitText(source.proofPrompt, 750), x: 115, y: 555, fontSize: 38, weight: 850, fill: "#E5E7EB", maxChars: 39, maxLines: 17, lineHeight: 1.12, family: "Courier New, monospace" })}
    <rect x="90" y="1450" width="900" height="150" rx="36" fill="#092132" stroke="#38BDF8" stroke-width="3"/>
    ${textBlock({ text: "No vibes. This is the actual prompt path.", x: 540, y: 1545, fontSize: 44, weight: 950, fill: "#22D3EE", maxChars: 34, maxLines: 1, anchor: "middle" })}
  ${closeSvg()}`);

  slides.push(`${baseSvg(3, "LIVE OUTPUT")}
    ${textBlock({ text: "WHAT IT GAVE ME", x: 90, y: 350, fontSize: 78, weight: 950, fill: "#FFFFFF", maxChars: 17, maxLines: 1 })}
    <rect x="70" y="440" width="940" height="980" rx="36" fill="#F8FAFC" stroke="#E2E8F0" stroke-width="3"/>
    ${outputLines.slice(0, 7).map((line, i) => `
      <rect x="110" y="${520 + i * 110}" width="860" height="82" rx="20" fill="${i === 1 ? "#DCFCE7" : i % 2 ? "#EEF2FF" : "#FFFFFF"}" stroke="${i === 1 ? "#22C55E" : "#E2E8F0"}" stroke-width="3"/>
      ${textBlock({ text: hardLimitText(line, 74), x: 145, y: 575 + i * 110, fontSize: 29, weight: i === 1 ? 950 : 830, fill: "#020617", maxChars: 39, maxLines: 1 })}
    `).join("\n")}
    <rect x="110" y="1490" width="860" height="128" rx="34" fill="#052E16" stroke="#22C55E" stroke-width="5"/>
    ${textBlock({ text: "ACTUAL OUTPUT. NOT A TOOL LIST.", x: 540, y: 1570, fontSize: 42, weight: 950, fill: "#86EFAC", maxChars: 31, maxLines: 1, anchor: "middle" })}
  ${closeSvg()}`);

  slides.push(`${baseSvg(4, "BIG NUMBERS")}
    ${textBlock({ text: source.metric1Value, x: 540, y: 560, fontSize: 190, weight: 950, fill: "#A3E635", maxChars: 10, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: source.metric1Label.toUpperCase(), x: 540, y: 650, fontSize: 40, weight: 950, fill: "#FFFFFF", maxChars: 24, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: source.metric2Value, x: 540, y: 1040, fontSize: 150, weight: 950, fill: "#38BDF8", maxChars: 15, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: source.metric2Label.toUpperCase(), x: 540, y: 1120, fontSize: 40, weight: 950, fill: "#FFFFFF", maxChars: 24, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: source.metric3Value, x: 540, y: 1450, fontSize: 170, weight: 950, fill: "#D946EF", maxChars: 10, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: source.metric3Label.toUpperCase(), x: 540, y: 1535, fontSize: 40, weight: 950, fill: "#FFFFFF", maxChars: 24, maxLines: 1, anchor: "middle" })}
  ${closeSvg()}`);

  slides.push(`${baseSvg(5, "VERDICT")}
    ${textBlock({ text: "WOULD I USE THIS?", x: 540, y: 390, fontSize: 84, weight: 950, fill: "#FFFFFF", maxChars: 22, maxLines: 1, anchor: "middle" })}
    <rect x="90" y="510" width="900" height="520" rx="42" fill="#020617" stroke="#22C55E" stroke-width="6" filter="url(#shadow)"/>
    ${textBlock({ text: hardLimitText(source.verdict, 310), x: 140, y: 620, fontSize: 48, weight: 900, fill: "#E5E7EB", maxChars: 31, maxLines: 7, lineHeight: 1.1 })}
    <rect x="100" y="1180" width="880" height="180" rx="46" fill="#111827" stroke="#FACC15" stroke-width="5"/>
    ${textBlock({ text: "YES — WITH A REAL FRAMEWORK", x: 540, y: 1292, fontSize: 54, weight: 950, fill: "#FACC15", maxChars: 28, maxLines: 1, anchor: "middle" })}
  ${closeSvg()}`);

  slides.push(`${baseSvg(6, "SAVE THIS")}
    ${textBlock({ text: "THE RULE", x: 540, y: 400, fontSize: 96, weight: 950, fill: "#38BDF8", maxChars: 10, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: "AI tools are only interesting when the receipts are visible.", x: 100, y: 600, fontSize: 74, weight: 950, fill: "#FFFFFF", maxChars: 22, maxLines: 4, lineHeight: 1.04 })}
    <rect x="100" y="1230" width="880" height="250" rx="42" fill="#020617" stroke="#D946EF" stroke-width="5"/>
    ${textBlock({ text: "real input → real output → real verdict", x: 540, y: 1375, fontSize: 46, weight: 950, fill: "#F0ABFC", maxChars: 34, maxLines: 1, anchor: "middle" })}
  ${closeSvg()}`);

  slides.push(`${baseSvg(7, "NEXT TEST")}
    ${textBlock({ text: "WHICH AI TOOL NEXT?", x: 540, y: 520, fontSize: 82, weight: 950, fill: "#FFFFFF", maxChars: 22, maxLines: 2, anchor: "middle" })}
    <rect x="120" y="760" width="840" height="320" rx="42" fill="#020617" stroke="#38BDF8" stroke-width="5"/>
    ${textBlock({ text: "Comment the tool. I will test it with a real workflow, not a homepage review.", x: 170, y: 880, fontSize: 52, weight: 900, fill: "#E5E7EB", maxChars: 28, maxLines: 4, lineHeight: 1.08 })}
    <rect x="170" y="1240" width="740" height="140" rx="70" fill="#FFFFFF"/>
    ${textBlock({ text: "FULL RECEIPTS LINKED", x: 540, y: 1332, fontSize: 48, weight: 950, fill: "#020617", maxChars: 24, maxLines: 1, anchor: "middle" })}
  ${closeSvg()}`);

  return slides;
}

async function svgToPngBuffer(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function getR2ObjectKey(recordId) {
  return `${R2_PREFIX}/${recordId}/video.mp4`;
}

function getR2PublicUrl(recordId) {
  if (!R2_PUBLIC_BASE_URL) return "";
  return `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${getR2ObjectKey(recordId)}`;
}

async function r2ObjectExists(recordId) {
  if (!r2Client) return false;
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: getR2ObjectKey(recordId) }));
    return true;
  } catch {
    return false;
  }
}

async function fetchAirtableRecord(recordId) {
  if (!AIRTABLE_TOKEN) throw new Error("Server missing AIRTABLE_PERSONAL_ACCESS_TOKEN");
  const response = await fetch(`${AIRTABLE_TABLE_URL}/${recordId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Airtable fetch failed: ${response.status} ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

async function uploadToR2(recordId, mp4Buffer) {
  if (!r2Client) throw new Error("R2 is not configured");
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: getR2ObjectKey(recordId),
    Body: mp4Buffer,
    ContentType: "video/mp4",
    CacheControl: "public, max-age=31536000, immutable"
  }));
  return getR2PublicUrl(recordId);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed with code ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

async function renderMp4ForRecord(recordId) {
  const record = await fetchAirtableRecord(recordId);
  const source = normalizeSource(record.fields || {});
  const keyCover = await keyArtCover(source.keyArtUrl);
  const slides = await buildSlides(source);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `aitl-proof-footage-v2-${recordId}-`));
  const outputPath = path.join(workDir, "video.mp4");
  const listPath = path.join(workDir, "slides.txt");
  const slidePaths = [];

  try {
    for (let index = 0; index < slides.length; index++) {
      let pngBuffer = index === 0 && keyCover ? keyCover : await svgToPngBuffer(slides[index]);
      const slidePath = path.join(workDir, `slide_${String(index + 1).padStart(3, "0")}.png`);
      await fs.writeFile(slidePath, pngBuffer);
      slidePaths.push(slidePath);
    }

    const durations = [1.8, 3.2, 4.2, 3.2, 3.5, 3.2, 3.2];
    let concatText = "";
    for (let i = 0; i < slidePaths.length; i++) {
      concatText += `file '${slidePaths[i].replace(/'/g, "'\\''")}'\n`;
      concatText += `duration ${durations[i] || 3}\n`;
    }
    concatText += `file '${slidePaths[slidePaths.length - 1].replace(/'/g, "'\\''")}'\n`;
    await fs.writeFile(listPath, concatText);

    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-movflags", "+faststart",
      outputPath
    ]);

    const buffer = await fs.readFile(outputPath);
    const videoUrl = await uploadToR2(recordId, buffer);
    return { ok: true, recordId, status: "ready", videoUrl, storage: "r2" };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function enqueueRender(recordId) {
  const existing = renderQueue.find((j) => j.recordId === recordId && ["queued", "rendering"].includes(j.status));
  if (existing) return existing;
  const job = { recordId, status: "queued", createdAt: new Date().toISOString(), result: null, error: null };
  renderQueue.push(job);
  processQueue();
  return job;
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (renderQueue.length) {
      const job = renderQueue[0];
      job.status = "rendering";
      try {
        job.result = await renderMp4ForRecord(job.recordId);
        job.status = "ready";
      } catch (error) {
        job.status = "failed";
        job.error = error?.message || String(error);
      }
      job.finishedAt = new Date().toISOString();
      jobHistory.set(job.recordId, { ...job });
      renderQueue.shift();
    }
  } finally {
    queueRunning = false;
  }
}

function requireServerAuth(req, res, next) {
  const key = req.headers["x-render-key"] || req.query.key || req.body?.key;
  if (key !== SERVER_RENDER_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

function requireImageAccess(req, res, next) {
  const key = req.query.key;
  if (key !== IMAGE_ACCESS_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Tool Logbook Scrollstop Proof Renderer",
    storage: "r2",
    r2Configured: Boolean(r2Client && R2_PUBLIC_BASE_URL && R2_BUCKET),
    bucket: R2_BUCKET,
    cloudinary: false,
    layout: "proof-footage-v2-scrollstop-safe720",
    video: "ffmpeg-r2-proof-footage-v2-safe720",
    dimensions: `${WIDTH}x${HEIGHT}`,
    r2KeyPrefix: R2_PREFIX,
    renderMode: "proof-footage-v2-safe720-debug-visible",
    queueRunning,
    queuedJobs: renderQueue.length,
    ffmpegPath: Boolean(ffmpegPath),
    timestamp: new Date().toISOString()
  });
});

app.post("/render/aitl-carousel-video", requireServerAuth, async (req, res) => {
  try {
    const recordId = cleanText(req.body?.recordId);
    if (!recordId) return res.status(400).json({ ok: false, error: "Missing recordId" });
    const exists = await r2ObjectExists(recordId);
    const videoUrl = getR2PublicUrl(recordId);
    if (exists && req.body?.force !== true) return res.json({ ok: true, renderId: `aitl_scrollstop_proof_${recordId}`, status: "ready", videoUrl, storage: "r2" });
    const job = enqueueRender(recordId);
    return res.status(202).json({ ok: true, renderId: `aitl_scrollstop_proof_${recordId}`, status: job.status, videoUrl, storage: "r2", notes: "Proof Footage V2 Scrollstop render queued." });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Render trigger failed", message: error?.message || String(error) });
  }
});

app.get("/render/aitl-carousel-video/status/:recordId", async (req, res) => {
  const recordId = cleanText(req.params.recordId);
  const videoUrl = getR2PublicUrl(recordId);
  const queued = renderQueue.find((j) => j.recordId === recordId);
  if (queued) {
    return res.json({
      ok: true,
      recordId,
      status: queued.status,
      videoUrl,
      error: queued.error || null,
      createdAt: queued.createdAt || null
    });
  }

  const exists = await r2ObjectExists(recordId);
  if (exists) {
    return res.json({
      ok: true,
      recordId,
      status: "ready",
      videoUrl
    });
  }

  const history = jobHistory.get(recordId);
  if (history) {
    return res.json({
      ok: history.status !== "failed",
      recordId,
      status: history.status,
      videoUrl,
      error: history.error || null,
      result: history.result || null,
      createdAt: history.createdAt || null,
      finishedAt: history.finishedAt || null
    });
  }

  return res.json({
    ok: true,
    recordId,
    status: "missing",
    videoUrl,
    notes: "No queued job, no finished job in memory, and no R2 object found."
  });
});

app.get("/render/aitl-carousel-video/debug/:recordId", async (req, res) => {
  const recordId = cleanText(req.params.recordId);
  const videoUrl = getR2PublicUrl(recordId);
  const queued = renderQueue.find((j) => j.recordId === recordId) || null;
  const history = jobHistory.get(recordId) || null;
  const exists = await r2ObjectExists(recordId);
  return res.json({
    ok: true,
    recordId,
    videoUrl,
    r2Exists: exists,
    queued,
    history,
    queueRunning,
    queuedJobs: renderQueue.length,
    timestamp: new Date().toISOString()
  });
});

app.get("/slides/:recordId/:slideNumber.png", requireImageAccess, async (req, res) => {
  try {
    const recordId = cleanText(req.params.recordId);
    const slideNumber = Number(req.params.slideNumber);
    if (!recordId || !Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > 7) return res.status(400).json({ ok: false, error: "Invalid slide URL" });
    const record = await fetchAirtableRecord(recordId);
    const source = normalizeSource(record.fields || {});
    const keyCover = await keyArtCover(source.keyArtUrl);
    if (slideNumber === 1 && keyCover) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      return res.send(keyCover);
    }
    const slides = await buildSlides(source);
    const pngBuffer = await svgToPngBuffer(slides[slideNumber - 1]);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(pngBuffer);
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Slide render failed", message: error?.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`AI Tool Logbook Scrollstop Proof Renderer running on port ${PORT}`);
});
