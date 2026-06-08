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
const R2_PREFIX = "aitl-proof-footage-v1";
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
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function cleanNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
      current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function wrapText(value, maxChars, maxLines = 99) {
  const rawLines = cleanText(value).split("\n");
  const lines = rawLines.flatMap((line) => wrapLine(line, maxChars));
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = hardLimitText(clipped[maxLines - 1], Math.max(8, maxChars));
  return clipped;
}

function textBlock({ text, x, y, fontSize = 48, weight = 800, fill = "#FFFFFF", maxChars = 24, maxLines = 99, lineHeight = 1.12, anchor = "start", opacity = 1, letterSpacing = 0 }) {
  const lines = wrapText(text, maxChars, maxLines);
  const tspans = lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : fontSize * lineHeight}">${esc(line)}</tspan>`).join("");
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${fill}" opacity="${opacity}" letter-spacing="${letterSpacing}">${tspans}</text>`;
}

function pill({ x, y, w, h, fill = "#FFFFFF", stroke = "none", text = "", textFill = "#0F172A", fontSize = 24 }) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${stroke === "none" ? 0 : 3}"/>${textBlock({ text, x: x + w / 2, y: y + h / 2 + fontSize * 0.36, fontSize, weight: 950, fill: textFill, maxChars: 32, maxLines: 1, anchor: "middle", letterSpacing: 1 })}`;
}

function progressBar(slideIndex) {
  const total = 7;
  const gap = 12;
  const barWidth = 110;
  const startX = 112;
  const y = 1760;
  let output = "";
  for (let i = 1; i <= total; i++) {
    output += `<rect x="${startX + (i - 1) * (barWidth + gap)}" y="${y}" width="${barWidth}" height="10" rx="5" fill="${i <= slideIndex ? "#38BDF8" : "#334155"}"/>`;
  }
  return output;
}

function proofShell({ slideIndex, label, toolName, bodySvg, dark = true }) {
  const panelFill = dark ? "#08111F" : "#FFFFFF";
  const stroke = dark ? "#1E3A8A" : "#CBD5E1";
  const muted = dark ? "#93A4B8" : "#64748B";
  const logoFill = dark ? "#FFFFFF" : "#020617";
  const logoText = dark ? "#020617" : "#FFFFFF";

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="pageBg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#020617"/>
        <stop offset="48%" stop-color="#0B1120"/>
        <stop offset="100%" stop-color="#312E81"/>
      </linearGradient>
      <linearGradient id="cyanGlow" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#38BDF8"/>
        <stop offset="52%" stop-color="#2563EB"/>
        <stop offset="100%" stop-color="#7C3AED"/>
      </linearGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="24" stdDeviation="30" flood-color="#000000" flood-opacity="0.42"/></filter>
      <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="20" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#pageBg)"/>
    <circle cx="900" cy="260" r="320" fill="#2563EB" opacity="0.16" filter="url(#softGlow)"/>
    <circle cx="120" cy="1530" r="340" fill="#7C3AED" opacity="0.16" filter="url(#softGlow)"/>
    <rect x="58" y="58" width="964" height="1804" rx="54" fill="${panelFill}" stroke="${stroke}" stroke-width="3" filter="url(#shadow)"/>
    <rect x="58" y="58" width="964" height="18" rx="9" fill="url(#cyanGlow)"/>
    ${pill({ x: 100, y: 106, w: 310, h: 56, fill: logoFill, text: "AI TOOL LOGBOOK", textFill: logoText, fontSize: 22 })}
    ${pill({ x: 100, y: 184, w: 300, h: 48, fill: "#0F172A", stroke: "#38BDF8", text: label, textFill: "#7DD3FC", fontSize: 21 })}
    ${textBlock({ text: `${String(slideIndex).padStart(2, "0")} / 07`, x: 940, y: 148, fontSize: 32, weight: 950, fill: muted, maxChars: 10, maxLines: 1, anchor: "end" })}
    ${bodySvg}
    ${textBlock({ text: hardLimitText(toolName, 42), x: 100, y: 1715, fontSize: 30, weight: 900, fill: muted, maxChars: 38, maxLines: 2 })}
    ${progressBar(slideIndex)}
  </svg>`;
}

function terminalWindow({ x, y, w, h, title = "api test", lines = [], prompt = "" }) {
  let output = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="34" fill="#020617" stroke="#334155" stroke-width="4"/>`;
  output += `<rect x="${x}" y="${y}" width="${w}" height="86" rx="34" fill="#0F172A"/>`;
  output += `<circle cx="${x + 48}" cy="${y + 43}" r="13" fill="#EF4444"/><circle cx="${x + 88}" cy="${y + 43}" r="13" fill="#F59E0B"/><circle cx="${x + 128}" cy="${y + 43}" r="13" fill="#22C55E"/>`;
  output += textBlock({ text: title, x: x + 170, y: y + 53, fontSize: 26, weight: 900, fill: "#CBD5E1", maxChars: 30, maxLines: 1 });
  let currentY = y + 145;
  for (const line of lines.slice(0, 8)) {
    output += textBlock({ text: line, x: x + 46, y: currentY, fontSize: 30, weight: 850, fill: "#D1FAE5", maxChars: 44, maxLines: 1 });
    currentY += 54;
  }
  if (prompt) {
    output += `<rect x="${x + 34}" y="${currentY + 10}" width="${w - 68}" height="${Math.min(240, h - (currentY - y) - 48)}" rx="24" fill="#111827" stroke="#1E40AF" stroke-width="3"/>`;
    output += textBlock({ text: prompt, x: x + 62, y: currentY + 70, fontSize: 28, weight: 750, fill: "#E5E7EB", maxChars: 46, maxLines: 5, lineHeight: 1.16 });
  }
  return output;
}

function documentBox({ x, y, w, h, title = "source input", text = "", accent = "#38BDF8" }) {
  let output = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="34" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="4"/>`;
  output += `<rect x="${x}" y="${y}" width="${w}" height="82" rx="34" fill="#EFF6FF"/>`;
  output += `<rect x="${x}" y="${y + 64}" width="${w}" height="18" fill="#EFF6FF"/>`;
  output += textBlock({ text: title.toUpperCase(), x: x + 40, y: y + 52, fontSize: 26, weight: 950, fill: "#1D4ED8", maxChars: 34, maxLines: 1, letterSpacing: 1 });
  output += `<rect x="${x + 40}" y="${y + 120}" width="14" height="${h - 170}" rx="7" fill="${accent}"/>`;
  output += textBlock({ text, x: x + 80, y: y + 170, fontSize: 32, weight: 780, fill: "#0F172A", maxChars: 39, maxLines: 13, lineHeight: 1.16 });
  return output;
}

function outputReceipt({ x, y, w, h, title = "actual output", text = "" }) {
  let output = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="36" fill="#F8FAFC" stroke="#94A3B8" stroke-width="4"/>`;
  output += `<rect x="${x + 30}" y="${y + 30}" width="${w - 60}" height="78" rx="24" fill="#020617"/>`;
  output += textBlock({ text: title.toUpperCase(), x: x + 60, y: y + 80, fontSize: 26, weight: 950, fill: "#38BDF8", maxChars: 36, maxLines: 1, letterSpacing: 1 });
  const lines = wrapText(text, 46, 15);
  let cy = y + 160;
  lines.forEach((line, index) => {
    const fill = index % 2 === 0 ? "#FFFFFF" : "#EEF2FF";
    output += `<rect x="${x + 30}" y="${cy - 36}" width="${w - 60}" height="52" rx="12" fill="${fill}"/>`;
    output += textBlock({ text: line, x: x + 58, y: cy, fontSize: 27, weight: 780, fill: "#0F172A", maxChars: 46, maxLines: 1 });
    cy += 58;
  });
  return output;
}

function metricTile({ x, y, w, h, label, value, accent = "#38BDF8" }) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="34" fill="#0F172A" stroke="${accent}" stroke-width="4"/>
    ${textBlock({ text: label.toUpperCase(), x: x + 32, y: y + 54, fontSize: 24, weight: 950, fill: "#94A3B8", maxChars: 22, maxLines: 1, letterSpacing: 1 })}
    ${textBlock({ text: value, x: x + w / 2, y: y + 142, fontSize: 58, weight: 950, fill: "#FFFFFF", maxChars: 12, maxLines: 1, anchor: "middle" })}`;
}

function splitOutputLines(value, max = 6) {
  const raw = cleanText(value)
    .split(/\n+/)
    .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 12);
  return raw.slice(0, max);
}

function normalizeSource(source = {}) {
  const metric1Label = cleanText(source.metric1Label, "Response time");
  const metric1Value = cleanText(source.metric1Value, "--");
  const metric2Label = cleanText(source.metric2Label, "Output length");
  const metric2Value = cleanText(source.metric2Value, "--");
  const metric3Label = cleanText(source.metric3Label, "Usability");
  const metric3Value = cleanText(source.metric3Value, "--");

  const outputExcerpt = cleanText(source.proofOutputExcerpt || source.actualOutput || source.testResult || source.rawOutput, "No output excerpt captured yet.");
  const messyInput = cleanText(source.messyInput || source.proofInput, "No messy source input captured yet.");
  const prompt = cleanText(source.testPrompt || source.proofPrompt, "No test prompt captured yet.");
  const verdict = cleanText(source.proofVerdict || source.honestVerdict || source.verdict, "No verdict captured yet.");
  const runner = cleanText(source.proofRunner, source.toolName || "AI API");
  const testType = cleanText(source.proofTestType, "API Text Output");

  return {
    toolName: cleanText(source.toolName, "AI Tool"),
    title: cleanText(source.title, "Real AI Tool Test"),
    shockFaceUrl: cleanText(source.shockFaceUrl, ""),
    runner,
    testType,
    viewerProblem: cleanText(source.viewerProblem, "Creators need repeatable content output, not another generic AI tip."),
    toolAction: cleanText(source.toolAction, "Run the real workflow through the API and judge the output."),
    messyInput,
    prompt,
    rawOutput: cleanText(source.rawOutput, outputExcerpt),
    outputExcerpt,
    metric1Label,
    metric1Value,
    metric2Label,
    metric2Value,
    metric3Label,
    metric3Value,
    completedAt: cleanText(source.completedAt, "captured now"),
    proofContext: cleanText(source.proofContext, `${runner} returned a real API result for ${testType}.`),
    verdict,
    comedyReaction: cleanText(source.comedyReaction, "This is actual output, not a homepage review."),
    useItIf: cleanText(source.useItIf, "You have a real framework and need repeatable creator output."),
    skipItIf: cleanText(source.skipItIf, "You expect useful output from vague prompts."),
    caption: cleanText(source.caption, "")
  };
}

function browserFrame({ x = 64, y = 126, w = 952, h = 1500, title = "AI Tool Logbook Live Test", url = "api.openai.com / real output" }) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="42" fill="#07111F" stroke="#1E3A8A" stroke-width="4" filter="url(#shadow)"/>
    <rect x="${x}" y="${y}" width="${w}" height="94" rx="42" fill="#0F172A"/>
    <rect x="${x}" y="${y + 50}" width="${w}" height="44" fill="#0F172A"/>
    <circle cx="${x + 52}" cy="${y + 47}" r="13" fill="#EF4444"/>
    <circle cx="${x + 92}" cy="${y + 47}" r="13" fill="#F59E0B"/>
    <circle cx="${x + 132}" cy="${y + 47}" r="13" fill="#22C55E"/>
    <rect x="${x + 190}" y="${y + 24}" width="${w - 245}" height="46" rx="23" fill="#020617" stroke="#1E293B" stroke-width="2"/>
    ${textBlock({ text: url, x: x + 216, y: y + 55, fontSize: 23, weight: 850, fill: "#94A3B8", maxChars: 50, maxLines: 1 })}
    ${textBlock({ text: title, x: x + 42, y: y + 142, fontSize: 30, weight: 950, fill: "#E5E7EB", maxChars: 40, maxLines: 1 })}
  `;
}

function aiBg({ slideIndex = 1, label = "REAL AI TOOL TEST" }) {
  return `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#020617"/>
          <stop offset="52%" stop-color="#07111F"/>
          <stop offset="100%" stop-color="#111827"/>
        </linearGradient>
        <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#00D9FF"/>
          <stop offset="50%" stop-color="#2563EB"/>
          <stop offset="100%" stop-color="#7C3AED"/>
        </linearGradient>
        <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="22" stdDeviation="25" flood-color="#000000" flood-opacity="0.46"/>
        </filter>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
      <circle cx="930" cy="270" r="370" fill="#2563EB" opacity="0.18"/>
      <circle cx="120" cy="1560" r="370" fill="#7C3AED" opacity="0.17"/>
      <rect x="0" y="0" width="${WIDTH}" height="20" fill="url(#brand)"/>
      <rect x="0" y="${HEIGHT - 20}" width="${WIDTH}" height="20" fill="url(#brand)"/>
      <rect x="64" y="56" width="300" height="58" rx="29" fill="#FFFFFF"/>
      ${textBlock({ text: "AI TOOL LOGBOOK", x: 214, y: 94, fontSize: 25, weight: 950, fill: "#020617", maxChars: 21, maxLines: 1, anchor: "middle", letterSpacing: 1 })}
      <rect x="64" y="132" width="320" height="54" rx="27" fill="#06121F" stroke="#38BDF8" stroke-width="3"/>
      ${textBlock({ text: label, x: 224, y: 168, fontSize: 23, weight: 950, fill: "#7DD3FC", maxChars: 22, maxLines: 1, anchor: "middle", letterSpacing: 1 })}
      ${textBlock({ text: `${String(slideIndex).padStart(2, "0")} / 07`, x: 948, y: 112, fontSize: 34, weight: 950, fill: "#CBD5E1", maxChars: 8, maxLines: 1, anchor: "end" })}
  `;
}

function closeSvg() {
  return `</svg>`;
}

function terminalBox({ x, y, w, h, lines = [] }) {
  let out = `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="32" fill="#020617" stroke="#334155" stroke-width="4"/>
    <rect x="${x}" y="${y}" width="${w}" height="76" rx="32" fill="#111827"/>
    <circle cx="${x + 42}" cy="${y + 38}" r="12" fill="#EF4444"/>
    <circle cx="${x + 80}" cy="${y + 38}" r="12" fill="#F59E0B"/>
    <circle cx="${x + 118}" cy="${y + 38}" r="12" fill="#22C55E"/>
    ${textBlock({ text: "LIVE API CALL", x: x + 160, y: y + 48, fontSize: 24, weight: 950, fill: "#D1FAE5", maxChars: 28, maxLines: 1, letterSpacing: 1 })}
  `;
  let yy = y + 130;
  for (const line of lines.slice(0, 8)) {
    out += textBlock({ text: line, x: x + 42, y: yy, fontSize: 27, weight: 850, fill: "#D1FAE5", maxChars: 42, maxLines: 1, family: "Courier New, monospace" });
    yy += 52;
  }
  return out;
}

function outputReceipt({ x, y, w, h, lines = [], highlight = 1 }) {
  let out = `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="34" fill="#F8FAFC" stroke="#E2E8F0" stroke-width="3"/>
    <rect x="${x + 28}" y="${y + 28}" width="${w - 56}" height="68" rx="24" fill="#0F172A"/>
    ${textBlock({ text: "ACTUAL OUTPUT RECEIPT", x: x + 64, y: y + 72, fontSize: 25, weight: 950, fill: "#38BDF8", maxChars: 30, maxLines: 1, letterSpacing: 1 })}
  `;
  let yy = y + 148;
  lines.slice(0, 8).forEach((line, idx) => {
    const isHot = idx === highlight;
    out += `<rect x="${x + 34}" y="${yy - 36}" width="${w - 68}" height="58" rx="16" fill="${isHot ? "#DBEAFE" : idx % 2 ? "#EEF2FF" : "#FFFFFF"}" stroke="${isHot ? "#2563EB" : "none"}" stroke-width="${isHot ? 3 : 0}"/>`;
    out += textBlock({ text: line, x: x + 62, y: yy, fontSize: 26, weight: isHot ? 950 : 820, fill: "#0F172A", maxChars: 42, maxLines: 1 });
    yy += 64;
  });
  return out;
}

function metricCard({ x, y, label, value, color }) {
  return `
    <rect x="${x}" y="${y}" width="300" height="150" rx="30" fill="#020617" stroke="${color}" stroke-width="4" filter="url(#shadow)"/>
    ${textBlock({ text: label.toUpperCase(), x: x + 28, y: y + 46, fontSize: 22, weight: 950, fill: "#94A3B8", maxChars: 19, maxLines: 1, letterSpacing: 1 })}
    ${textBlock({ text: value, x: x + 150, y: y + 112, fontSize: 46, weight: 950, fill: "#FFFFFF", maxChars: 13, maxLines: 1, anchor: "middle" })}
  `;
}

function buildSlides(sourceInput = {}) {
  const p = normalizeSource(sourceInput);
  const outputLines = splitOutputLines(p.outputExcerpt || p.rawOutput, 10);
  const proofLines = outputLines.length ? outputLines : [p.outputExcerpt];
  const faceNote = p.shockFaceUrl ? "" : "Add AITL Shock Face Image to unlock real face hook.";
  const caption = p.caption || `${p.toolName} proof-tested by AI Tool Logbook. Real API output captured. Metrics: ${p.metric1Label}: ${p.metric1Value}; ${p.metric2Label}: ${p.metric2Value}; ${p.metric3Label}: ${p.metric3Value}.`;

  const slides = [];

  slides.push(`${aiBg({ slideIndex: 1, label: "REAL AI TEST" })}
    <rect x="64" y="220" width="952" height="1430" rx="48" fill="rgba(2,6,23,0.52)" stroke="#1D4ED8" stroke-width="4" filter="url(#shadow)"/>
    ${textBlock({ text: "I TESTED", x: 96, y: 380, fontSize: 74, weight: 950, fill: "#38BDF8", maxChars: 12, maxLines: 1, letterSpacing: 2 })}
    ${textBlock({ text: hardLimitText(p.toolName, 32), x: 96, y: 520, fontSize: 86, weight: 950, fill: "#FFFFFF", maxChars: 13, maxLines: 3, lineHeight: 1.0 })}
    <rect x="96" y="760" width="520" height="10" rx="5" fill="url(#brand)"/>
    ${textBlock({ text: "NOT A HOMEPAGE REVIEW.", x: 96, y: 900, fontSize: 50, weight: 950, fill: "#FFFFFF", maxChars: 22, maxLines: 1 })}
    ${textBlock({ text: "REAL PROMPT IN. REAL OUTPUT OUT.", x: 96, y: 978, fontSize: 46, weight: 950, fill: "#E5E7EB", maxChars: 24, maxLines: 2, lineHeight: 1.05 })}
    <rect x="605" y="236" width="420" height="420" rx="210" fill="#0F172A" stroke="#38BDF8" stroke-width="6"/>
    ${textBlock({ text: faceNote, x: 640, y: 700, fontSize: 26, weight: 900, fill: "#FCA5A5", maxChars: 25, maxLines: 2 })}
    ${metricCard({ x: 96, y: 1295, label: p.metric1Label, value: p.metric1Value, color: "#38BDF8" })}
    ${metricCard({ x: 390, y: 1295, label: p.metric2Label, value: p.metric2Value, color: "#22C55E" })}
    ${metricCard({ x: 684, y: 1295, label: p.metric3Label, value: p.metric3Value, color: "#A78BFA" })}
    ${textBlock({ text: hardLimitText(p.viewerProblem, 100), x: 96, y: 1570, fontSize: 36, weight: 850, fill: "#CBD5E1", maxChars: 32, maxLines: 2 })}
  ${closeSvg()}`);

  slides.push(`${aiBg({ slideIndex: 2, label: "THE SETUP" })}
    ${browserFrame({ title: "The messy input before the test", url: "source-input.txt" })}
    ${textBlock({ text: "THIS WAS THE INPUT", x: 110, y: 340, fontSize: 64, weight: 950, fill: "#FFFFFF", maxChars: 18, maxLines: 2 })}
    <rect x="110" y="450" width="860" height="760" rx="36" fill="#020617" stroke="#334155" stroke-width="4"/>
    ${textBlock({ text: hardLimitText(p.messyInput, 520), x: 150, y: 535, fontSize: 34, weight: 800, fill: "#E5E7EB", maxChars: 39, maxLines: 13, lineHeight: 1.14 })}
    <rect x="110" y="1290" width="860" height="210" rx="34" fill="#082F49" stroke="#38BDF8" stroke-width="4"/>
    ${textBlock({ text: "THE TEST: Can it turn this into something usable?", x: 150, y: 1380, fontSize: 44, weight: 950, fill: "#FFFFFF", maxChars: 29, maxLines: 2 })}
  ${closeSvg()}`);

  slides.push(`${aiBg({ slideIndex: 3, label: "PROMPT RUN" })}
    ${browserFrame({ title: "The exact prompt that ran", url: "POST /v1/chat/completions" })}
    ${terminalBox({ x: 110, y: 300, w: 860, h: 600, lines: [
      "$ POST /v1/chat/completions",
      `> model: ${p.runner}`,
      "> input: messy framework",
      "> task: build usable system",
      "> status: running...",
      "> output: captured"
    ] })}
    <rect x="110" y="980" width="860" height="430" rx="36" fill="#020617" stroke="#2563EB" stroke-width="4"/>
    ${textBlock({ text: hardLimitText(p.prompt, 270), x: 150, y: 1070, fontSize: 34, weight: 820, fill: "#E5E7EB", maxChars: 38, maxLines: 8, lineHeight: 1.12 })}
    ${metricCard({ x: 110, y: 1500, label: p.metric1Label, value: p.metric1Value, color: "#38BDF8" })}
  ${closeSvg()}`);

  slides.push(`${aiBg({ slideIndex: 4, label: "OUTPUT RECEIPT" })}
    ${browserFrame({ title: "Actual generated output", url: "response-output.json" })}
    ${textBlock({ text: "HERE IS WHAT CAME BACK", x: 110, y: 320, fontSize: 58, weight: 950, fill: "#FFFFFF", maxChars: 22, maxLines: 2 })}
    ${outputReceipt({ x: 110, y: 440, w: 860, h: 840, lines: proofLines, highlight: 1 })}
    <rect x="110" y="1360" width="860" height="176" rx="34" fill="#052E16" stroke="#22C55E" stroke-width="4"/>
    ${textBlock({ text: "This is the receipt. Not vibes.", x: 150, y: 1464, fontSize: 48, weight: 950, fill: "#86EFAC", maxChars: 28, maxLines: 1 })}
  ${closeSvg()}`);

  slides.push(`${aiBg({ slideIndex: 5, label: "BIG NUMBERS" })}
    ${textBlock({ text: p.metric1Value, x: 540, y: 480, fontSize: 190, weight: 950, fill: "#38BDF8", maxChars: 10, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: p.metric1Label.toUpperCase(), x: 540, y: 560, fontSize: 38, weight: 950, fill: "#CBD5E1", maxChars: 24, maxLines: 1, anchor: "middle", letterSpacing: 2 })}
    <rect x="110" y="680" width="860" height="10" rx="5" fill="url(#brand)"/>
    ${textBlock({ text: p.metric2Value, x: 540, y: 980, fontSize: 120, weight: 950, fill: "#FFFFFF", maxChars: 16, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: p.metric2Label.toUpperCase(), x: 540, y: 1060, fontSize: 38, weight: 950, fill: "#CBD5E1", maxChars: 24, maxLines: 1, anchor: "middle", letterSpacing: 2 })}
    ${textBlock({ text: p.metric3Value, x: 540, y: 1380, fontSize: 150, weight: 950, fill: "#A78BFA", maxChars: 10, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: p.metric3Label.toUpperCase(), x: 540, y: 1460, fontSize: 38, weight: 950, fill: "#CBD5E1", maxChars: 24, maxLines: 1, anchor: "middle", letterSpacing: 2 })}
  ${closeSvg()}`);

  slides.push(`${aiBg({ slideIndex: 6, label: "VERDICT" })}
    ${browserFrame({ title: "Would I use this in production?", url: "final-verdict.md" })}
    ${textBlock({ text: "WOULD I USE THIS?", x: 110, y: 360, fontSize: 68, weight: 950, fill: "#FFFFFF", maxChars: 18, maxLines: 2 })}
    <rect x="110" y="500" width="860" height="500" rx="42" fill="#06121F" stroke="#38BDF8" stroke-width="4"/>
    ${textBlock({ text: hardLimitText(p.verdict, 280), x: 155, y: 600, fontSize: 44, weight: 900, fill: "#E5E7EB", maxChars: 30, maxLines: 7, lineHeight: 1.08 })}
    <rect x="160" y="1130" width="760" height="170" rx="42" fill="#052E16" stroke="#22C55E" stroke-width="6"/>
    ${textBlock({ text: "WORTH TESTING", x: 540, y: 1238, fontSize: 58, weight: 950, fill: "#86EFAC", maxChars: 18, maxLines: 1, anchor: "middle", letterSpacing: 1 })}
  ${closeSvg()}`);

  slides.push(`${aiBg({ slideIndex: 7, label: "NEXT TEST" })}
    ${textBlock({ text: "THE LESSON", x: 90, y: 340, fontSize: 76, weight: 950, fill: "#38BDF8", maxChars: 14, maxLines: 1, letterSpacing: 2 })}
    ${textBlock({ text: "AI tools are boring until you test them against a real workflow.", x: 90, y: 500, fontSize: 66, weight: 950, fill: "#FFFFFF", maxChars: 21, maxLines: 4, lineHeight: 1.02 })}
    <rect x="90" y="980" width="850" height="270" rx="42" fill="#020617" stroke="#334155" stroke-width="4"/>
    ${textBlock({ text: "Next test: another AI tool, same rule — real input, real output, real verdict.", x: 135, y: 1080, fontSize: 44, weight: 900, fill: "#E5E7EB", maxChars: 31, maxLines: 3 })}
    <rect x="90" y="1390" width="620" height="110" rx="55" fill="#FFFFFF"/>
    ${textBlock({ text: "SAVE THE RECEIPTS", x: 400, y: 1460, fontSize: 38, weight: 950, fill: "#020617", maxChars: 24, maxLines: 1, anchor: "middle" })}
    <rect x="735" y="1260" width="280" height="280" rx="140" fill="#0F172A" stroke="#38BDF8" stroke-width="5"/>
  ${closeSvg()}`);

  return { slides, caption };
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
  const response = await fetch(`${AIRTABLE_TABLE_URL}/${recordId}`, { method: "GET", headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" } });
  const responseText = await response.text();
  let data;
  try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }
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

async function renderMp4ForRecord(recordId) {
  const record = await fetchAirtableRecord(recordId);
  const source = sourceFromAirtableFields(record.fields || {});
  const { slides } = buildSlides(source);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `aitl-proof-footage-v1-${recordId}-`));
  const outputPath = path.join(workDir, "video.mp4");
  const listPath = path.join(workDir, "slides.txt");
  const slidePaths = [];

  for (let index = 0; index < slides.length; index++) {
    let pngBuffer = await svgToPngBuffer(slides[index]);
    pngBuffer = await compositeShockFace(pngBuffer, source, index);
    const slidePath = path.join(workDir, `slide_${String(index + 1).padStart(3, "0")}.png`);
    await fs.writeFile(slidePath, pngBuffer);
    slidePaths.push(slidePath);
  }

  let concatText = "";
  for (let index = 0; index < slidePaths.length; index++) {
    const duration = index === slidePaths.length - 1 ? 3.8 : 3.0;
    concatText += `file '${slidePaths[index].replaceAll("'", "'\\''")}'\n`;
    concatText += `duration ${duration}\n`;
  }
  concatText += `file '${slidePaths[slidePaths.length - 1].replaceAll("'", "'\\''")}'\n`;
  await fs.writeFile(listPath, concatText, "utf8");

  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    "-r", "30",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "24",
    "-movflags", "+faststart",
    outputPath
  ]);

  return { workDir, outputPath };
}

async function uploadMp4ToR2(recordId, filePath) {
  if (!r2Client) throw new Error("R2 client not configured.");
  if (!R2_PUBLIC_BASE_URL) throw new Error("Missing R2_PUBLIC_BASE_URL.");
  const fileBuffer = await fs.readFile(filePath);
  await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: getR2ObjectKey(recordId), Body: fileBuffer, ContentType: "video/mp4", CacheControl: "public, max-age=60" }));
  return getR2PublicUrl(recordId);
}

async function safeCleanup(dirPath) {
  if (!dirPath || !dirPath.includes("aitl-proof-footage-v1-")) return;
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
      console.log(`Proof Footage MP4 uploaded to R2 for ${recordId}: ${videoUrl}`);
    } catch (error) {
      if (workDir) await safeCleanup(workDir);
      renderJobs.set(recordId, { recordId, status: "failed", startedAt: job.startedAt, finishedAt: new Date().toISOString(), videoUrl: getR2PublicUrl(recordId), error: error?.message || String(error) });
      console.error(`Proof Footage background MP4 render failed for ${recordId}:`, error);
    }
  }
  queueRunning = false;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Tool Logbook Proof Footage Renderer",
    storage: "r2",
    r2Configured: Boolean(r2Client && R2_PUBLIC_BASE_URL && R2_BUCKET),
    bucket: R2_BUCKET,
    cloudinary: false,
    layout: "proof-footage-v1-shock-face",
    video: "ffmpeg-r2-proof-footage-v1",
    dimensions: `${WIDTH}x${HEIGHT}`,
    r2KeyPrefix: R2_PREFIX,
    renderMode: "proof-footage-single-ffmpeg-pass",
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
    return res.json({ ok: true, renderId: `aitl_proof_${recordId}`, style: "AI Tool Logbook Proof Footage V1", slideUrls, caption, notes: "Generated 7 vertical proof-evidence PNG slide URLs. Uses real proof fields." });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Proof evidence URL generation failed", message: error?.message || String(error) });
  }
});

app.post("/render/aitl-carousel-video", requireServerAuth, async (req, res) => {
  try {
    const recordId = cleanText(req.body?.recordId);
    if (!recordId) return res.status(400).json({ ok: false, error: "Missing recordId" });
    const exists = await r2ObjectExists(recordId);
    const videoUrl = getR2PublicUrl(recordId);
    if (exists && req.body?.force !== true) return res.json({ ok: true, renderId: `aitl_proof_video_${recordId}`, status: "ready", videoUrl, storage: "r2", notes: "Proof Footage MP4 already exists in R2. Send force=true to regenerate." });
    const job = enqueueBackgroundMp4Render(recordId);
    return res.status(202).json({ ok: true, renderId: `aitl_proof_video_${recordId}`, status: job.status, videoUrl, storage: "r2", notes: "Proof Footage MP4 render queued. Check status endpoint or open R2 URL after render completes." });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Proof evidence video render trigger failed", message: error?.message || String(error) });
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
    let pngBuffer = await svgToPngBuffer(slides[slideNumber - 1]);
    pngBuffer = await compositeShockFace(pngBuffer, source, slideNumber - 1);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(pngBuffer);
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Slide render failed", message: error?.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`AI Tool Logbook Proof Footage Renderer running on port ${PORT}`);
});
