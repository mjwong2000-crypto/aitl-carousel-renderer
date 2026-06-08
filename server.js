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
const R2_PREFIX = "aitl-proof-video-v1";
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

function buildSlides(sourceInput = {}) {
  const p = normalizeSource(sourceInput);
  const outputLines = splitOutputLines(p.outputExcerpt || p.rawOutput, 8);
  const proofBullets = outputLines.length ? outputLines : [p.outputExcerpt];
  const caption = p.caption || `${p.toolName} proof-tested by AI Tool Logbook. Real API output captured. Metrics: ${p.metric1Label}: ${p.metric1Value}; ${p.metric2Label}: ${p.metric2Value}; ${p.metric3Label}: ${p.metric3Value}.`;

  const slides = [];

  slides.push(proofShell({ slideIndex: 1, label: "REAL API TEST", toolName: p.toolName, dark: true, bodySvg: `
    ${textBlock({ text: "I TESTED", x: 100, y: 395, fontSize: 62, weight: 950, fill: "#38BDF8", maxChars: 12, maxLines: 1, letterSpacing: 2 })}
    ${textBlock({ text: hardLimitText(p.toolName, 34), x: 100, y: 545, fontSize: 96, weight: 950, fill: "#FFFFFF", maxChars: 14, maxLines: 3, lineHeight: 0.98 })}
    <rect x="100" y="870" width="880" height="10" rx="5" fill="url(#cyanGlow)"/>
    ${textBlock({ text: "Not a homepage review. Not a hype list. Real prompt in. Real output out.", x: 100, y: 1015, fontSize: 58, weight: 900, fill: "#E5E7EB", maxChars: 22, maxLines: 4, lineHeight: 1.05 })}
    ${metricTile({ x: 100, y: 1370, w: 260, h: 190, label: p.metric1Label, value: p.metric1Value, accent: "#38BDF8" })}
    ${metricTile({ x: 410, y: 1370, w: 260, h: 190, label: p.metric2Label, value: p.metric2Value, accent: "#22C55E" })}
    ${metricTile({ x: 720, y: 1370, w: 260, h: 190, label: p.metric3Label, value: p.metric3Value, accent: "#A78BFA" })}
  ` }));

  slides.push(proofShell({ slideIndex: 2, label: "SOURCE INPUT", toolName: p.toolName, dark: true, bodySvg: `
    ${textBlock({ text: "The messy input", x: 100, y: 350, fontSize: 68, weight: 950, fill: "#FFFFFF", maxChars: 20, maxLines: 1 })}
    ${textBlock({ text: hardLimitText(p.viewerProblem, 105), x: 100, y: 445, fontSize: 40, weight: 800, fill: "#CBD5E1", maxChars: 36, maxLines: 3, lineHeight: 1.12 })}
    ${documentBox({ x: 100, y: 635, w: 880, h: 830, title: "actual source given to tool", text: p.messyInput, accent: "#38BDF8" })}
    <rect x="100" y="1525" width="880" height="105" rx="30" fill="#0F172A" stroke="#38BDF8" stroke-width="3"/>
    ${textBlock({ text: "If the input is weak, the result will be weak.", x: 140, y: 1590, fontSize: 34, weight: 950, fill: "#7DD3FC", maxChars: 40, maxLines: 1 })}
  ` }));

  slides.push(proofShell({ slideIndex: 3, label: "API CALL", toolName: p.toolName, dark: true, bodySvg: `
    ${textBlock({ text: "The actual test", x: 100, y: 355, fontSize: 70, weight: 950, fill: "#FFFFFF", maxChars: 18, maxLines: 1 })}
    ${terminalWindow({ x: 100, y: 475, w: 880, h: 900, title: `${p.runner} / ${p.testType}`, lines: ["POST /v1/chat/completions", "status: 200 OK", `runner: ${hardLimitText(p.runner, 24)}`, `test: ${hardLimitText(p.testType, 24)}`, "input: creator framework", "output: generated response"], prompt: p.prompt })}
    <rect x="100" y="1450" width="880" height="120" rx="34" fill="#064E3B" stroke="#22C55E" stroke-width="3"/>
    ${textBlock({ text: hardLimitText(p.toolAction, 92), x: 140, y: 1520, fontSize: 34, weight: 900, fill: "#D1FAE5", maxChars: 40, maxLines: 2 })}
  ` }));

  slides.push(proofShell({ slideIndex: 4, label: "REAL OUTPUT", toolName: p.toolName, dark: true, bodySvg: `
    ${textBlock({ text: "This is what came back", x: 100, y: 350, fontSize: 62, weight: 950, fill: "#FFFFFF", maxChars: 23, maxLines: 2, lineHeight: 1.02 })}
    ${outputReceipt({ x: 100, y: 525, w: 880, h: 920, title: "generated output excerpt", text: p.outputExcerpt })}
    <rect x="100" y="1510" width="880" height="110" rx="32" fill="#111827" stroke="#A78BFA" stroke-width="3"/>
    ${textBlock({ text: p.comedyReaction, x: 140, y: 1580, fontSize: 36, weight: 950, fill: "#EDE9FE", maxChars: 40, maxLines: 1 })}
  ` }));

  slides.push(proofShell({ slideIndex: 5, label: "PROOF METRICS", toolName: p.toolName, dark: true, bodySvg: `
    ${textBlock({ text: "Proof dashboard", x: 100, y: 350, fontSize: 70, weight: 950, fill: "#FFFFFF", maxChars: 18, maxLines: 1 })}
    ${metricTile({ x: 100, y: 500, w: 880, h: 210, label: p.metric1Label, value: p.metric1Value, accent: "#38BDF8" })}
    ${metricTile({ x: 100, y: 770, w: 880, h: 210, label: p.metric2Label, value: p.metric2Value, accent: "#22C55E" })}
    ${metricTile({ x: 100, y: 1040, w: 880, h: 210, label: p.metric3Label, value: p.metric3Value, accent: "#A78BFA" })}
    <rect x="100" y="1330" width="880" height="230" rx="44" fill="#0F172A" stroke="#475569" stroke-width="3"/>
    ${textBlock({ text: `Captured: ${hardLimitText(p.completedAt, 45)}`, x: 140, y: 1410, fontSize: 34, weight: 900, fill: "#CBD5E1", maxChars: 40, maxLines: 1 })}
    ${textBlock({ text: hardLimitText(p.proofContext, 110), x: 140, y: 1490, fontSize: 32, weight: 800, fill: "#94A3B8", maxChars: 43, maxLines: 2 })}
  ` }));

  slides.push(proofShell({ slideIndex: 6, label: "WHAT WORKED", toolName: p.toolName, dark: true, bodySvg: `
    ${textBlock({ text: "Useful parts from the output", x: 100, y: 350, fontSize: 60, weight: 950, fill: "#FFFFFF", maxChars: 24, maxLines: 2, lineHeight: 1.04 })}
    ${outputReceipt({ x: 100, y: 520, w: 880, h: 650, title: "proof receipts", text: proofBullets.join("\n") })}
    <rect x="100" y="1260" width="420" height="260" rx="38" fill="#022C22" stroke="#22C55E" stroke-width="4"/>
    ${textBlock({ text: "USE IT IF", x: 136, y: 1330, fontSize: 32, weight: 950, fill: "#86EFAC", maxChars: 18, maxLines: 1, letterSpacing: 1 })}
    ${textBlock({ text: p.useItIf, x: 136, y: 1410, fontSize: 31, weight: 850, fill: "#FFFFFF", maxChars: 20, maxLines: 3, lineHeight: 1.12 })}
    <rect x="560" y="1260" width="420" height="260" rx="38" fill="#450A0A" stroke="#EF4444" stroke-width="4"/>
    ${textBlock({ text: "SKIP IT IF", x: 596, y: 1330, fontSize: 32, weight: 950, fill: "#FCA5A5", maxChars: 18, maxLines: 1, letterSpacing: 1 })}
    ${textBlock({ text: p.skipItIf, x: 596, y: 1410, fontSize: 31, weight: 850, fill: "#FFFFFF", maxChars: 20, maxLines: 3, lineHeight: 1.12 })}
  ` }));

  slides.push(proofShell({ slideIndex: 7, label: "FINAL VERDICT", toolName: p.toolName, dark: true, bodySvg: `
    ${textBlock({ text: "Final verdict", x: 100, y: 355, fontSize: 72, weight: 950, fill: "#38BDF8", maxChars: 18, maxLines: 1, letterSpacing: 1 })}
    <rect x="100" y="500" width="880" height="360" rx="58" fill="url(#cyanGlow)"/>
    ${textBlock({ text: "REAL OUTPUT CAPTURED", x: 540, y: 665, fontSize: 58, weight: 950, fill: "#FFFFFF", maxChars: 22, maxLines: 2, anchor: "middle", lineHeight: 1.02 })}
    ${textBlock({ text: `${p.metric1Label}: ${p.metric1Value}  •  ${p.metric3Label}: ${p.metric3Value}`, x: 540, y: 785, fontSize: 30, weight: 950, fill: "#E0F2FE", maxChars: 44, maxLines: 1, anchor: "middle" })}
    ${textBlock({ text: hardLimitText(p.verdict, 230), x: 100, y: 1040, fontSize: 54, weight: 950, fill: "#FFFFFF", maxChars: 25, maxLines: 6, lineHeight: 1.08 })}
    <rect x="100" y="1550" width="720" height="92" rx="46" fill="#FFFFFF"/>
    ${textBlock({ text: "Save this before testing another AI tool.", x: 140, y: 1608, fontSize: 31, weight: 950, fill: "#020617", maxChars: 38, maxLines: 1 })}
  ` }));

  return { slides, caption };
}

function sourceFromAirtableFields(fields = {}) {
  return {
    toolName: fields["Tool Name"],
    title: fields["Title"],
    proofRunner: fields["AITL Proof Runner"],
    proofTestType: fields["AITL Proof Test Type"],
    proofInput: fields["AITL Proof Input"],
    messyInput: fields["AITL Messy Input"],
    viewerProblem: fields["AITL Viewer Problem"],
    toolAction: fields["AITL Tool Action"],
    proofPrompt: fields["AITL Proof Prompt"],
    testPrompt: fields["AITL Test Prompt"],
    rawOutput: fields["AITL Proof Raw Output"],
    proofOutputExcerpt: fields["AITL Proof Output Excerpt"],
    actualOutput: fields["AITL Actual Output"],
    testResult: fields["AITL Test Result"],
    metric1Label: fields["AITL Proof Metric 1 Label"],
    metric1Value: fields["AITL Proof Metric One Value"],
    metric2Label: fields["AITL Proof Metric 2 Label"],
    metric2Value: fields["AITL Proof Metric Two Result"],
    metric3Label: fields["AITL Proof Metric Three Label"],
    metric3Value: fields["AITL Proof Metric Three Result"],
    proofVerdict: fields["AITL Proof Verdict"],
    honestVerdict: fields["AITL Honest Verdict"],
    verdict: fields["Verdict"],
    comedyReaction: fields["AITL Comedy Reaction"],
    useItIf: fields["Use It If"],
    skipItIf: fields["Skip It If"],
    completedAt: fields["AITL Proof Completed Time"],
    proofContext: fields["AITL Proof Context"],
    caption: fields["AITL Carousel Caption"]
  };
}

function getPublicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function getR2ObjectKey(recordId) {
  return `${R2_PREFIX}/${recordId}/carousel.mp4`;
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

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `aitl-proof-evidence-v1-${recordId}-`));
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
  if (!dirPath || !dirPath.includes("aitl-proof-evidence-v1-")) return;
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
      console.log(`Proof Evidence MP4 uploaded to R2 for ${recordId}: ${videoUrl}`);
    } catch (error) {
      if (workDir) await safeCleanup(workDir);
      renderJobs.set(recordId, { recordId, status: "failed", startedAt: job.startedAt, finishedAt: new Date().toISOString(), videoUrl: getR2PublicUrl(recordId), error: error?.message || String(error) });
      console.error(`Proof Evidence background MP4 render failed for ${recordId}:`, error);
    }
  }
  queueRunning = false;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Tool Logbook Proof Evidence Renderer",
    storage: "r2",
    r2Configured: Boolean(r2Client && R2_PUBLIC_BASE_URL && R2_BUCKET),
    bucket: R2_BUCKET,
    cloudinary: false,
    layout: "proof-evidence-v1",
    video: "ffmpeg-r2-proof-evidence-v1",
    dimensions: `${WIDTH}x${HEIGHT}`,
    r2KeyPrefix: R2_PREFIX,
    renderMode: "proof-evidence-single-ffmpeg-pass",
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
    return res.json({ ok: true, renderId: `aitl_proof_${recordId}`, style: "AI Tool Logbook Proof Evidence V1", slideUrls, caption, notes: "Generated 7 vertical proof-evidence PNG slide URLs. Uses real proof fields." });
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
    if (exists && req.body?.force !== true) return res.json({ ok: true, renderId: `aitl_proof_video_${recordId}`, status: "ready", videoUrl, storage: "r2", notes: "Proof Evidence MP4 already exists in R2. Send force=true to regenerate." });
    const job = enqueueBackgroundMp4Render(recordId);
    return res.status(202).json({ ok: true, renderId: `aitl_proof_video_${recordId}`, status: job.status, videoUrl, storage: "r2", notes: "Proof Evidence MP4 render queued. Check status endpoint or open R2 URL after render completes." });
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
    const pngBuffer = await svgToPngBuffer(slides[slideNumber - 1]);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(pngBuffer);
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Slide render failed", message: error?.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`AI Tool Logbook Proof Evidence Renderer running on port ${PORT}`);
});
