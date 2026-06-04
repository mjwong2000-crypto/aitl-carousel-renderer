import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config();

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const RENDER_KEY = process.env.AITL_RENDERER_KEY;
const IMAGE_ACCESS_KEY = process.env.AITL_IMAGE_ACCESS_KEY || RENDER_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN;

const AIRTABLE_BASE_ID = "app47YuxOKMw8vkCj";
const AIRTABLE_TABLE_NAME = "AI Tool Radar";
const AIRTABLE_TABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

const WIDTH = 1080;
const HEIGHT = 1350;

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
  if (!IMAGE_ACCESS_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Server missing AITL_IMAGE_ACCESS_KEY"
    });
  }

  const suppliedKey = req.query.key;

  if (!suppliedKey || suppliedKey !== IMAGE_ACCESS_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized image request"
    });
  }

  next();
}

function cleanText(value, fallback = "") {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join("\n");
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function cleanBullets(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanText(item))
      .filter(Boolean)
      .slice(0, 6);
  }

  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\n|;/)
      .map((item) => item.replace(/^[-•\d.)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 6);
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

function wrapText(text, maxChars) {
  return String(text)
    .split("\n")
    .flatMap((line) => wrapLine(line, maxChars));
}

function textBlock({
  text,
  x,
  y,
  fontSize = 64,
  weight = 700,
  fill = "#0F172A",
  maxChars = 24,
  lineHeight = 1.15,
  anchor = "start",
  opacity = 1
}) {
  const lines = wrapText(text, maxChars);
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
      text-anchor="${anchor}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="${fontSize}"
      font-weight="${weight}"
      fill="${fill}"
      opacity="${opacity}"
    >${tspans}</text>
  `;
}

function bulletList({
  bullets,
  x,
  y,
  fontSize = 44,
  fill = "#111827",
  maxChars = 28,
  gap = 24
}) {
  let currentY = y;
  let output = "";

  for (const bullet of bullets) {
    const wrapped = wrapText(bullet, maxChars);
    const bulletHeight = wrapped.length * fontSize * 1.1 + gap;

    output += `
      <circle cx="${x}" cy="${currentY - fontSize * 0.32}" r="8" fill="#111827"/>
      ${textBlock({
        text: wrapped.join("\n"),
        x: x + 28,
        y: currentY,
        fontSize,
        weight: 650,
        fill,
        maxChars,
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

      <rect x="112" y="112" width="250" height="48" rx="24" fill="#111827"/>
      <text x="237" y="144" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="800" fill="#FFFFFF" letter-spacing="1.5">
        AI TOOL MYTHBUSTER
      </text>

      <text x="936" y="145" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="800" fill="#94A3B8">
        ${escapeXml(slideNumber)}
      </text>

      ${
        eyebrow
          ? `<text x="112" y="230" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="800" fill="#64748B" letter-spacing="1.2">${escapeXml(
              eyebrow
            )}</text>`
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
          text: copy.hookA,
          x: 112,
          y: 420,
          fontSize: 84,
          weight: 900,
          maxChars: 19,
          lineHeight: 1.06
        })}
        ${textBlock({
          text: copy.hookB,
          x: 112,
          y: 720,
          fontSize: 78,
          weight: 900,
          fill: "#2563EB",
          maxChars: 20,
          lineHeight: 1.06
        })}
        <rect x="112" y="980" width="720" height="82" rx="41" fill="#EFF6FF"/>
        ${textBlock({
          text: "The platform was not the problem.",
          x: 154,
          y: 1034,
          fontSize: 36,
          weight: 800,
          fill: "#1D4ED8",
          maxChars: 34
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
          y: 395,
          fontSize: 58,
          weight: 900,
          maxChars: 24
        })}
        <rect x="112" y="486" width="856" height="310" rx="36" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="4"/>
        ${textBlock({
          text: `“${copy.falseBelief}”`,
          x: 154,
          y: 610,
          fontSize: 62,
          weight: 900,
          fill: "#DC2626",
          maxChars: 22,
          lineHeight: 1.08
        })}
        ${textBlock({
          text: copy.reframeLine,
          x: 112,
          y: 930,
          fontSize: 60,
          weight: 900,
          fill: "#111827",
          maxChars: 24,
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
          text: "So I asked ChatGPT:",
          x: 112,
          y: 370,
          fontSize: 56,
          weight: 900,
          maxChars: 24
        })}
        <rect x="112" y="450" width="856" height="540" rx="38" fill="#111827"/>
        ${textBlock({
          text: `“${copy.proofPrompt}”`,
          x: 158,
          y: 560,
          fontSize: 44,
          weight: 750,
          fill: "#FFFFFF",
          maxChars: 31,
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
          y: 365,
          fontSize: 58,
          weight: 900,
          maxChars: 23
        })}
        ${bulletList({
          bullets: copy.proofBullets,
          x: 132,
          y: 520,
          fontSize: 48,
          fill: "#111827",
          maxChars: 27,
          gap: 30
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
          text: copy.proofNumber,
          x: 112,
          y: 430,
          fontSize: 84,
          weight: 950,
          fill: "#16A34A",
          maxChars: 18,
          lineHeight: 1.05
        })}
        <rect x="112" y="690" width="856" height="320" rx="38" fill="#F0FDF4" stroke="#86EFAC" stroke-width="4"/>
        ${textBlock({
          text: copy.proofContext,
          x: 154,
          y: 805,
          fontSize: 58,
          weight: 900,
          fill: "#166534",
          maxChars: 25,
          lineHeight: 1.1
        })}
        ${textBlock({
          text: copy.proofLine,
          x: 154,
          y: 925,
          fontSize: 64,
          weight: 950,
          fill: "#111827",
          maxChars: 22
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
          text: "USE CHATGPT FOR:",
          x: 154,
          y: 370,
          fontSize: 38,
          weight: 950,
          fill: "#1D4ED8",
          maxChars: 25
        })}
        ${bulletList({
          bullets: copy.useBullets,
          x: 172,
          y: 465,
          fontSize: 38,
          fill: "#111827",
          maxChars: 32,
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
          maxChars: 25
        })}
        ${bulletList({
          bullets: copy.skipBullets,
          x: 172,
          y: 905,
          fontSize: 38,
          fill: "#111827",
          maxChars: 34,
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
          text: copy.takeaway,
          x: 112,
          y: 385,
          fontSize: 66,
          weight: 950,
          fill: "#111827",
          maxChars: 24,
          lineHeight: 1.12
        })}
        <rect x="112" y="1020" width="660" height="82" rx="41" fill="#111827"/>
        ${textBlock({
          text: "Save this if you build with AI.",
          x: 154,
          y: 1074,
          fontSize: 34,
          weight: 900,
          fill: "#FFFFFF",
          maxChars: 34
        })}
      `
    })
  );

  const caption =
    copy.caption ||
    `${copy.hookA} ${copy.hookB}\n\nBefore you quit a platform, test the angle.\n\nUse ChatGPT to test assumptions, sharpen positioning, and turn vague ideas into repeatable formats.\n\nSave this if you’re building with AI tools.`;

  return {
    copy,
    slides,
    caption
  };
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
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = forwardedProto || req.protocol || "https";
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
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Airtable fetch failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function svgToPngBuffer(svg) {
  return sharp(Buffer.from(svg))
    .png({
      quality: 100,
      compressionLevel: 9
    })
    .toBuffer();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Tool Logbook Automated Carousel Renderer",
    storage: "none",
    cloudinary: false,
    timestamp: new Date().toISOString()
  });
});

app.post("/render/aitl-carousel", requireServerAuth, async (req, res) => {
  try {
    const recordId = cleanText(req.body?.recordId);

    if (!recordId) {
      return res.status(400).json({
        ok: false,
        error: "Missing recordId"
      });
    }

    const style = cleanText(req.body?.style, "AI Tool MythBuster");

    if (style !== "AI Tool MythBuster") {
      return res.status(400).json({
        ok: false,
        error: "Unsupported carousel style",
        receivedStyle: style
      });
    }

    const source = req.body?.source || {};
    const { caption } = buildSlides(source);
    const renderId = `aitl_${recordId}`;

    const baseUrl = getPublicBaseUrl(req);

    const slideUrls = [1, 2, 3, 4, 5, 6, 7].map((slideNumber) => {
      return `${baseUrl}/slides/${recordId}/${slideNumber}.png?key=${encodeURIComponent(
        IMAGE_ACCESS_KEY
      )}`;
    });

    return res.json({
      ok: true,
      renderId,
      style,
      slideUrls,
      caption,
      notes: `Generated 7 live PNG slide URLs from renderer service. No Cloudinary. No external image storage.`
    });
  } catch (error) {
    console.error("Carousel URL generation failed:", error);

    return res.status(500).json({
      ok: false,
      error: "Carousel URL generation failed",
      message: error?.message || String(error)
    });
  }
});

app.get("/slides/:recordId/:slideNumber.png", requireImageAccess, async (req, res) => {
  try {
    const recordId = req.params.recordId;
    const slideNumber = Number(req.params.slideNumber);

    if (!recordId || !Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > 7) {
      return res.status(400).json({
        ok: false,
        error: "Invalid slide URL"
      });
    }

    const record = await fetchAirtableRecord(recordId);
    const source = sourceFromAirtableFields(record.fields || {});
    const { slides } = buildSlides(source);

    const svg = slides[slideNumber - 1];
    const pngBuffer = await svgToPngBuffer(svg);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");

    return res.send(pngBuffer);
  } catch (error) {
    console.error("Slide render failed:", error);

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
