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
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const RENDER_KEY = process.env.AITL_RENDERER_KEY;
const IMAGE_ACCESS_KEY = process.env.AITL_IMAGE_ACCESS_KEY || RENDER_KEY;
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
const HEIGHT = 1920;
const FPS = 30;
const renderJobs = new Map();
const renderQueue = [];
let queueRunning = false;

const r2Client = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
    })
  : null;

const DEFAULT_COPY = {
  toolName: "AI Tool",
  title: "AI Tool MythBuster",
  hookA: "I tested this AI tool for creator workflows.",
  hookB: "Fast is useless if the output is wrong.",
  falseBelief: "AI tools save time automatically.",
  reframeLine: "The real test is repeatability.",
  proofPrompt: "Can this tool turn one rough idea into a useful, repeatable creator workflow?",
  proofBullets: ["Clearer output", "Faster workflow", "Reusable content angle"],
  proofContext: "This was tested as a creator workflow tool.",
  proofLine: "The value depends on the prompt quality.",
  useBullets: ["You need faster ideas", "You want repeatable workflows", "You test tools before buying"],
  skipBullets: ["You expect perfect output", "You use vague prompts", "You do not check the result"],
  takeaway: "Do not judge an AI tool by the hype. Test the output, workflow, and repeatability first."
};

function requireServerAuth(req, res, next) {
  if (!RENDER_KEY) return res.status(500).json({ ok: false, error: "Server missing AITL_RENDERER_KEY" });
  if (req.headers["x-render-key"] !== RENDER_KEY) return res.status(401).json({ ok: false, error: "Unauthorized renderer request" });
  next();
}

function requireImageAccess(req, res, next) {
  if (!IMAGE_ACCESS_KEY || req.query.key !== IMAGE_ACCESS_KEY) return res.status(401).json({ ok: false, error: "Unauthorized image request" });
  next();
}

function cleanText(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).join("\n");
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function cleanNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanBullets(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean).slice(0, 5);
  if (typeof value === "string" && value.trim()) {
    return value.split(/\n|;/).map((item) => item.replace(/^[-•\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 5);
  }
  return fallback;
}

function esc(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function hardLimitText(value, maxChars) {
  const text = cleanText(value).replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trim()}…`;
}

function wrapLine(line, maxChars) {
  const words = String(line).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length <= maxChars) current = test;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function wrapText(text, maxChars, maxLines = 99) {
  const lines = String(text).split("\n").flatMap((line) => wrapLine(line, maxChars));
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = hardLimitText(clipped[maxLines - 1], maxChars - 1);
  return clipped;
}

function textBlock({ text, x, y, fontSize = 64, weight = 700, fill = "#0F172A", maxChars = 24, maxLines = 99, lineHeight = 1.12, anchor = "start", letterSpacing = 0 }) {
  const lines = wrapText(text, maxChars, maxLines);
  const tspans = lines.map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : fontSize * lineHeight}">${esc(line)}</tspan>`).join("");
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${fill}" letter-spacing="${letterSpacing}">${tspans}</text>`;
}

function pill({ x, y, w, h, fill, text, textFill, fontSize = 24 }) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>${textBlock({ text, x: x + w / 2, y: y + h / 2 + fontSize * 0.36, fontSize, weight: 900, fill: textFill, maxChars: 28, maxLines: 1, anchor: "middle", letterSpacing: 1.2 })}`;
}

function progressBar(slideIndex) {
  const total = 7, gap = 12, barWidth = 110, startX = 112, y = 1740;
  let output = "";
  for (let i = 1; i <= total; i++) {
    output += `<rect x="${startX + (i - 1) * (barWidth + gap)}" y="${y}" width="${barWidth}" height="10" rx="5" fill="${i <= slideIndex ? "#00D9FF" : "#334155"}"/>`;
  }
  return output;
}

function shell({ slideIndex, label, toolName, bodySvg, mode = "light" }) {
  const dark = mode === "dark";
  const card = dark ? "#0B1020" : "#FFFFFF";
  const muted = dark ? "#94A3B8" : "#64748B";
  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${dark ? "#020617" : "#F8FAFC"}"/><stop offset="45%" stop-color="${dark ? "#111827" : "#E0F2FE"}"/><stop offset="100%" stop-color="${dark ? "#312E81" : "#FDF2F8"}"/></linearGradient>
      <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7C3AED"/><stop offset="100%" stop-color="#00D9FF"/></linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="#020617" flood-opacity="${dark ? "0.42" : "0.16"}"/></filter>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
    <circle cx="950" cy="210" r="300" fill="#7C3AED" opacity="${dark ? "0.22" : "0.13"}"/>
    <circle cx="100" cy="1570" r="300" fill="#00D9FF" opacity="${dark ? "0.10" : "0.13"}"/>
    <rect x="72" y="78" width="936" height="1710" rx="64" fill="${card}" filter="url(#shadow)"/>
    ${pill({ x: 112, y: 122, w: 310, h: 54, fill: dark ? "#FFFFFF" : "#111827", text: "AI TOOL LOGBOOK", textFill: dark ? "#0F172A" : "#FFFFFF", fontSize: 22 })}
    ${pill({ x: 112, y: 202, w: 310, h: 48, fill: "#DBEAFE", text: label, textFill: "#1D4ED8", fontSize: 21 })}
    ${textBlock({ text: `${String(slideIndex).padStart(2, "0")} / 07`, x: 936, y: 160, fontSize: 30, weight: 900, fill: muted, maxChars: 8, maxLines: 1, anchor: "end" })}
    ${textBlock({ text: hardLimitText(toolName, 44), x: 112, y: 1692, fontSize: 32, weight: 900, fill: muted, maxChars: 30, maxLines: 2 })}
    ${bodySvg}
    ${progressBar(slideIndex)}
  </svg>`;
}

function bulletCards({ bullets, x, y, width, accent = "#7C3AED", fontSize = 40 }) {
  let output = "";
  let currentY = y;
  for (const bullet of bullets.slice(0, 4)) {
    output += `<rect x="${x}" y="${currentY}" width="${width}" height="136" rx="28" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="3"/><rect x="${x}" y="${currentY}" width="18" height="136" rx="9" fill="${accent}"/>${textBlock({ text: bullet, x: x + 44, y: currentY + 58, fontSize, weight: 850, fill: "#0F172A", maxChars: 28, maxLines: 2, lineHeight: 1.08 })}`;
    currentY += 164;
  }
  return output;
}

function metricBar({ label, value, x, y, width = 760, color = "#7C3AED" }) {
  const safeValue = Math.max(0, Math.min(10, cleanNumber(value, 0)));
  const fillWidth = Math.round((safeValue / 10) * width);
  return `${textBlock({ text: label, x, y, fontSize: 36, weight: 900, fill: "#0F172A", maxChars: 20, maxLines: 1 })}${textBlock({ text: `${safeValue}/10`, x: x + width, y, fontSize: 36, weight: 900, fill: "#0F172A", maxChars: 8, maxLines: 1, anchor: "end" })}<rect x="${x}" y="${y + 32}" width="${width}" height="28" rx="14" fill="#E2E8F0"/><rect x="${x}" y="${y + 32}" width="${fillWidth}" height="28" rx="14" fill="${color}"/>`;
}

function normalizeSource(source = {}) {
  const creatorFitScore = cleanNumber(source.creatorFitScore, 7);
  const monetizationFitScore = cleanNumber(source.monetizationFitScore, 7);
  const trendScore = cleanNumber(source.trendScore, 7);
  const totalScore = cleanNumber(source.aitlTotalScore, 0) || creatorFitScore + monetizationFitScore + trendScore || 21;
  return {
    toolName: cleanText(source.toolName, DEFAULT_COPY.toolName),
    title: cleanText(source.title, DEFAULT_COPY.title),
    hookA: cleanText(source.hookA, DEFAULT_COPY.hookA),
    hookB: cleanText(source.hookB, DEFAULT_COPY.hookB),
    falseBelief: cleanText(source.falseBelief, DEFAULT_COPY.falseBelief),
    reframeLine: cleanText(source.reframeLine, DEFAULT_COPY.reframeLine),
    proofPrompt: cleanText(source.proofPrompt, DEFAULT_COPY.proofPrompt),
    proofBullets: cleanBullets(source.proofBullets, DEFAULT_COPY.proofBullets),
    proofContext: cleanText(source.proofContext, DEFAULT_COPY.proofContext),
    proofLine: cleanText(source.proofLine, DEFAULT_COPY.proofLine),
    useBullets: cleanBullets(source.useBullets, DEFAULT_COPY.useBullets),
    skipBullets: cleanBullets(source.skipBullets, DEFAULT_COPY.skipBullets),
    takeaway: cleanText(source.takeaway, DEFAULT_COPY.takeaway),
    caption: cleanText(source.caption, ""),
    creatorFitScore,
    monetizationFitScore,
    trendScore,
    totalScore
  };
}

function buildSlides(sourceInput = {}) {
  const copy = normalizeSource(sourceInput);
  const slides = [];
  slides.push(shell({ slideIndex: 1, label: "MYTH TEST", toolName: copy.toolName, mode: "dark", bodySvg: `${textBlock({ text: "AI TOOL TEST", x: 112, y: 420, fontSize: 58, weight: 950, fill: "#00D9FF", maxChars: 18, maxLines: 1, letterSpacing: 2 })}${textBlock({ text: hardLimitText(copy.hookA, 120), x: 112, y: 570, fontSize: 86, weight: 950, fill: "#FFFFFF", maxChars: 16, maxLines: 5, lineHeight: 1.02 })}<rect x="112" y="1180" width="856" height="260" rx="44" fill="url(#glow)"/>${textBlock({ text: hardLimitText(copy.hookB, 88), x: 154, y: 1280, fontSize: 50, weight: 950, fill: "#FFFFFF", maxChars: 24, maxLines: 3, lineHeight: 1.06 })}<rect x="112" y="1494" width="470" height="84" rx="42" fill="#FFFFFF"/>${textBlock({ text: "VERDICT IN 20 SEC", x: 347, y: 1548, fontSize: 28, weight: 950, fill: "#0F172A", maxChars: 24, maxLines: 1, anchor: "middle" })}` }));
  slides.push(shell({ slideIndex: 2, label: "BAD ASSUMPTION", toolName: copy.toolName, bodySvg: `${textBlock({ text: "The myth:", x: 112, y: 395, fontSize: 58, weight: 950, fill: "#0F172A", maxChars: 20, maxLines: 1 })}<rect x="112" y="500" width="856" height="450" rx="48" fill="#FEF2F2" stroke="#FCA5A5" stroke-width="4"/>${textBlock({ text: `“${hardLimitText(copy.falseBelief, 150)}”`, x: 154, y: 630, fontSize: 60, weight: 950, fill: "#DC2626", maxChars: 22, maxLines: 5, lineHeight: 1.06 })}<rect x="112" y="1060" width="856" height="360" rx="48" fill="#EFF6FF" stroke="#93C5FD" stroke-width="4"/>${textBlock({ text: "The better test:", x: 154, y: 1150, fontSize: 38, weight: 950, fill: "#2563EB", maxChars: 24, maxLines: 1 })}${textBlock({ text: hardLimitText(copy.reframeLine, 120), x: 154, y: 1245, fontSize: 52, weight: 950, fill: "#0F172A", maxChars: 25, maxLines: 3, lineHeight: 1.08 })}` }));
  slides.push(shell({ slideIndex: 3, label: "TEST PROMPT", toolName: copy.toolName, mode: "dark", bodySvg: `${textBlock({ text: "I asked it one useful question:", x: 112, y: 390, fontSize: 54, weight: 950, fill: "#FFFFFF", maxChars: 24, maxLines: 2, lineHeight: 1.08 })}<rect x="112" y="560" width="856" height="760" rx="48" fill="#020617" stroke="#334155" stroke-width="4"/><rect x="150" y="610" width="110" height="32" rx="16" fill="#22C55E"/><rect x="280" y="610" width="110" height="32" rx="16" fill="#F59E0B"/><rect x="410" y="610" width="110" height="32" rx="16" fill="#EF4444"/>${textBlock({ text: `“${hardLimitText(copy.proofPrompt, 280)}”`, x: 154, y: 760, fontSize: 44, weight: 800, fill: "#E5E7EB", maxChars: 31, maxLines: 9, lineHeight: 1.15 })}<rect x="112" y="1400" width="856" height="120" rx="36" fill="#7C3AED"/>${textBlock({ text: "No screenshots. No demo tricks. Just the workflow test.", x: 154, y: 1475, fontSize: 36, weight: 900, fill: "#FFFFFF", maxChars: 38, maxLines: 2 })}` }));
  slides.push(shell({ slideIndex: 4, label: "OUTPUT", toolName: copy.toolName, bodySvg: `${textBlock({ text: "What it returned:", x: 112, y: 390, fontSize: 64, weight: 950, fill: "#0F172A", maxChars: 20, maxLines: 1 })}${bulletCards({ bullets: copy.proofBullets, x: 112, y: 500, width: 856, accent: "#7C3AED", fontSize: 42 })}<rect x="112" y="1328" width="856" height="190" rx="42" fill="#ECFDF5" stroke="#86EFAC" stroke-width="4"/>${textBlock({ text: hardLimitText(copy.proofLine, 110), x: 154, y: 1412, fontSize: 44, weight: 950, fill: "#166534", maxChars: 29, maxLines: 3, lineHeight: 1.08 })}` }));
  slides.push(shell({ slideIndex: 5, label: "PROOF SCORE", toolName: copy.toolName, bodySvg: `${textBlock({ text: "Proof score", x: 112, y: 390, fontSize: 74, weight: 950, fill: "#0F172A", maxChars: 16, maxLines: 1 })}<rect x="112" y="500" width="856" height="250" rx="50" fill="#111827"/>${textBlock({ text: `${copy.totalScore}/30`, x: 540, y: 650, fontSize: 112, weight: 950, fill: "#FFFFFF", maxChars: 8, maxLines: 1, anchor: "middle" })}${textBlock({ text: "AI TOOL LOGBOOK SCORE", x: 540, y: 710, fontSize: 26, weight: 950, fill: "#93C5FD", maxChars: 28, maxLines: 1, anchor: "middle", letterSpacing: 1.5 })}${metricBar({ label: "Creator fit", value: copy.creatorFitScore, x: 154, y: 900, width: 760, color: "#2563EB" })}${metricBar({ label: "Money fit", value: copy.monetizationFitScore, x: 154, y: 1060, width: 760, color: "#16A34A" })}${metricBar({ label: "Trend pull", value: copy.trendScore, x: 154, y: 1220, width: 760, color: "#7C3AED" })}<rect x="112" y="1450" width="856" height="120" rx="40" fill="#EFF6FF"/>${textBlock({ text: hardLimitText(copy.proofContext, 90), x: 154, y: 1525, fontSize: 34, weight: 850, fill: "#1D4ED8", maxChars: 38, maxLines: 2 })}` }));
  slides.push(shell({ slideIndex: 6, label: "USE / SKIP", toolName: copy.toolName, bodySvg: `<rect x="112" y="360" width="856" height="520" rx="52" fill="#EFF6FF" stroke="#93C5FD" stroke-width="4"/>${textBlock({ text: "USE IT IF", x: 154, y: 455, fontSize: 48, weight: 950, fill: "#1D4ED8", maxChars: 20, maxLines: 1, letterSpacing: 1.5 })}${bulletCards({ bullets: copy.useBullets, x: 154, y: 530, width: 770, accent: "#2563EB", fontSize: 34 })}<rect x="112" y="990" width="856" height="500" rx="52" fill="#FEF2F2" stroke="#FCA5A5" stroke-width="4"/>${textBlock({ text: "SKIP IT IF", x: 154, y: 1085, fontSize: 48, weight: 950, fill: "#DC2626", maxChars: 20, maxLines: 1, letterSpacing: 1.5 })}${bulletCards({ bullets: copy.skipBullets, x: 154, y: 1160, width: 770, accent: "#DC2626", fontSize: 34 })}` }));
  slides.push(shell({ slideIndex: 7, label: "FINAL VERDICT", toolName: copy.toolName, mode: "dark", bodySvg: `${textBlock({ text: "FINAL VERDICT", x: 112, y: 410, fontSize: 58, weight: 950, fill: "#00D9FF", maxChars: 20, maxLines: 1, letterSpacing: 2 })}<rect x="112" y="510" width="856" height="310" rx="56" fill="url(#glow)"/>${textBlock({ text: copy.totalScore >= 22 ? "WORTH TESTING" : "NEEDS PROOF", x: 540, y: 690, fontSize: 76, weight: 950, fill: "#FFFFFF", maxChars: 16, maxLines: 2, anchor: "middle", lineHeight: 1.02 })}${textBlock({ text: hardLimitText(copy.takeaway, 190), x: 112, y: 980, fontSize: 58, weight: 950, fill: "#FFFFFF", maxChars: 23, maxLines: 6, lineHeight: 1.08 })}<rect x="112" y="1510" width="720" height="100" rx="50" fill="#FFFFFF"/>${textBlock({ text: "Save this before testing another AI tool.", x: 154, y: 1572, fontSize: 34, weight: 950, fill: "#0F172A", maxChars: 34, maxLines: 1 })}` }));
  const caption = copy.caption || `${copy.toolName} tested for creator workflow use.\n\nScore: ${copy.totalScore}/30\n\nUse it if: ${copy.useBullets.join(", ")}\n\nSkip it if: ${copy.skipBullets.join(", ")}\n\nSave this if you are building with AI tools.`;
  return { slides, caption };
}

function sourceFromAirtableFields(fields = {}) {
  return {
    toolName: fields["Tool Name"],
    title: fields["Title"],
    hookA: fields["AITL Carousel Hook A"],
    hookB: fields["AITL Carousel Hook B"],
    falseBelief: fields["AITL False Belief"],
    reframeLine: fields["AITL Reframe Line"],
    proofPrompt: fields["AITL Proof Prompt"],
    proofBullets: fields["AITL Proof Bullets"],
    proofContext: fields["AITL Proof Context"],
    proofLine: fields["AITL Proof Line"],
    useBullets: fields["AITL Use Bullets"],
    skipBullets: fields["AITL Skip Bullets"],
    takeaway: fields["AITL Takeaway"],
    caption: fields["AITL Carousel Caption"],
    creatorFitScore: fields["Creator Fit Score"],
    monetizationFitScore: fields["Monetization Fit Score"],
    trendScore: fields["Trend Score"],
    aitlTotalScore: fields["AITL Total Score"]
  };
}

function getPublicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function getR2ObjectKey(recordId) {
  return `aitl-carousel/${recordId}/carousel.mp4`;
}

function getR2PublicUrl(recordId) {
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
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Airtable fetch failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function svgToPngBuffer(svg) {
  return sharp(Buffer.from(svg)).png({ quality: 100, compressionLevel: 9 }).toBuffer();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg-static path is missing."));
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`)); });
  });
}

async function renderSegmentFromPng(inputPath, outputPath, durationSeconds, slideIndex) {
  const frames = Math.round(durationSeconds * FPS);
  const zoomSpeed = slideIndex % 2 === 0 ? "0.00055" : "0.00075";
  await runFfmpeg(["-y", "-loop", "1", "-i", inputPath, "-frames:v", String(frames), "-vf", `zoompan=z='min(zoom+${zoomSpeed},1.045)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", outputPath]);
}

async function renderMp4ForRecord(recordId) {
  const record = await fetchAirtableRecord(recordId);
  const source = sourceFromAirtableFields(record.fields || {});
  const { slides } = buildSlides(source);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `aitl-v4-video-${recordId}-`));
  const outputPath = path.join(workDir, "carousel.mp4");
  const listPath = path.join(workDir, "segments.txt");
  const segmentPaths = [];
  for (let i = 0; i < slides.length; i++) {
    const pngBuffer = await svgToPngBuffer(slides[i]);
    const slidePath = path.join(workDir, `slide_${String(i + 1).padStart(3, "0")}.png`);
    const segmentPath = path.join(workDir, `segment_${String(i + 1).padStart(3, "0")}.mp4`);
    await fs.writeFile(slidePath, pngBuffer);
    await renderSegmentFromPng(slidePath, segmentPath, i === slides.length - 1 ? 3.6 : 2.8, i + 1);
    segmentPaths.push(segmentPath);
  }
  const concatText = segmentPaths.map((segmentPath) => `file '${segmentPath.replaceAll("'", "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, concatText, "utf8");
  await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath]);
  return { workDir, outputPath };
}

async function uploadMp4ToR2(recordId, filePath) {
  if (!r2Client) throw new Error("R2 client not configured.");
  if (!R2_PUBLIC_BASE_URL) throw new Error("Missing R2_PUBLIC_BASE_URL.");
  const fileBuffer = await fs.readFile(filePath);
  await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: getR2ObjectKey(recordId), Body: fileBuffer, ContentType: "video/mp4", CacheControl: "public, max-age=31536000" }));
  return getR2PublicUrl(recordId);
}

async function safeCleanup(dirPath) {
  if (!dirPath || !dirPath.includes("aitl-v4-video-")) return;
  try { await fs.rm(dirPath, { recursive: true, force: true }); } catch (error) { console.error("Cleanup failed:", error); }
}

function enqueueBackgroundMp4Render(recordId) {
  const existingJob = renderJobs.get(recordId);
  if (existingJob?.status === "queued" || existingJob?.status === "rendering") return existingJob;
  const job = { recordId, status: "queued", startedAt: new Date().toISOString(), videoUrl: getR2PublicUrl(recordId), error: "" };
  renderJobs.set(recordId, job);
  renderQueue.push(recordId);
  setImmediate(processRenderQueue);
  return job;
}

async function processRenderQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (renderQueue.length > 0) {
    const recordId = renderQueue.shift();
    const job = renderJobs.get(recordId);
    if (!job) continue;
    renderJobs.set(recordId, { ...job, status: "rendering", renderStartedAt: new Date().toISOString() });
    let workDir;
    try {
      const rendered = await renderMp4ForRecord(recordId);
      workDir = rendered.workDir;
      const videoUrl = await uploadMp4ToR2(recordId, rendered.outputPath);
      await safeCleanup(workDir);
      renderJobs.set(recordId, { recordId, status: "ready", startedAt: job.startedAt, finishedAt: new Date().toISOString(), videoUrl, error: "" });
      console.log(`V4 MP4 uploaded to R2 for ${recordId}: ${videoUrl}`);
    } catch (error) {
      if (workDir) await safeCleanup(workDir);
      renderJobs.set(recordId, { recordId, status: "failed", startedAt: job.startedAt, finishedAt: new Date().toISOString(), videoUrl: getR2PublicUrl(recordId), error: error?.message || String(error) });
      console.error(`V4 background MP4 render failed for ${recordId}:`, error);
    }
  }
  queueRunning = false;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Tool Logbook Automated Carousel Renderer",
    storage: "r2",
    r2Configured: Boolean(r2Client && R2_PUBLIC_BASE_URL && R2_BUCKET),
    bucket: R2_BUCKET,
    cloudinary: false,
    layout: "visual-proof-carousel-v4",
    video: "ffmpeg-r2-v4-vertical-motion",
    dimensions: `${WIDTH}x${HEIGHT}`,
    queueRunning,
    queuedJobs: renderQueue.length,
    ffmpegPath: Boolean(ffmpegPath),
    timestamp: new Date().toISOString()
  });
});

app.post("/render/aitl-carousel", requireServerAuth, async (req, res) => {
  try {
    const recordId = cleanText(req.body?.recordId);
    if (!recordId) return res.status(400).json({ ok: false, error: "Missing recordId" });
    const baseUrl = getPublicBaseUrl(req);
    const { caption } = buildSlides(req.body?.source || {});
    const slideUrls = [1, 2, 3, 4, 5, 6, 7].map((slideNumber) => `${baseUrl}/slides/${recordId}/${slideNumber}.png?key=${encodeURIComponent(IMAGE_ACCESS_KEY)}`);
    return res.json({ ok: true, renderId: `aitl_${recordId}`, style: "AI Tool Logbook Visual Proof Carousel V4", slideUrls, caption, notes: "Generated 7 vertical visual proof carousel PNG slide URLs. V4 layout." });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Carousel URL generation failed", message: error?.message || String(error) });
  }
});

app.post("/render/aitl-carousel-video", requireServerAuth, async (req, res) => {
  try {
    const recordId = cleanText(req.body?.recordId);
    if (!recordId) return res.status(400).json({ ok: false, error: "Missing recordId" });
    const exists = await r2ObjectExists(recordId);
    const videoUrl = getR2PublicUrl(recordId);
    if (exists && req.body?.force !== true) return res.json({ ok: true, renderId: `aitl_video_${recordId}`, status: "ready", videoUrl, storage: "r2", notes: "MP4 already exists in R2. Send force=true to regenerate with V4." });
    const job = enqueueBackgroundMp4Render(recordId);
    return res.status(202).json({ ok: true, renderId: `aitl_video_${recordId}`, status: job.status, videoUrl, storage: "r2", notes: "V4 vertical MP4 render queued. Check status endpoint or open R2 URL after render completes." });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Video render trigger failed", message: error?.message || String(error) });
  }
});

app.get("/render/aitl-carousel-video/status/:recordId", async (req, res) => {
  try {
    const recordId = req.params.recordId;
    const videoUrl = getR2PublicUrl(recordId);
    const job = renderJobs.get(recordId);
    if (job?.status === "queued" || job?.status === "rendering" || job?.status === "failed") return res.json({ ok: true, recordId, status: job.status, videoUrl, error: job.error || "" });
    const exists = await r2ObjectExists(recordId);
    if (exists) return res.json({ ok: true, recordId, status: "ready", videoUrl });
    if (job?.status === "ready") return res.json({ ok: true, recordId, status: "ready", videoUrl: job.videoUrl || videoUrl });
    return res.json({ ok: true, recordId, status: "missing", videoUrl });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Status check failed", message: error?.message || String(error) });
  }
});

app.get("/slides/:recordId/:slideNumber.png", requireImageAccess, async (req, res) => {
  try {
    const recordId = req.params.recordId;
    const slideNumber = Number(req.params.slideNumber);
    if (!recordId || !Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > 7) return res.status(400).json({ ok: false, error: "Invalid slide URL" });
    const record = await fetchAirtableRecord(recordId);
    const source = sourceFromAirtableFields(record.fields || {});
    const { slides } = buildSlides(source);
    const pngBuffer = await svgToPngBuffer(slides[slideNumber - 1]);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(pngBuffer);
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Slide render failed", message: error?.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`AI Tool Logbook V4 visual carousel renderer running on port ${PORT}`);
});
