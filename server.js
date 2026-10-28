const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

function validYouTubeUrl(u) {
  try {
    const url = new URL(u);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const h = url.hostname.toLowerCase();
    return h === "youtu.be" || /(^|\.)youtube\.com$/.test(h);
  } catch { return false; }
}

function run(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args);
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Timeout")); }, timeoutMs);
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("error", e => { clearTimeout(t); reject(e); });
    p.on("close", code => {
      clearTimeout(t);
      if (code === 0) return resolve(out);
      const lines = err.trim().split("\n").filter(Boolean);
      const errLine = lines.reverse().find(l => l.includes("ERROR")) || lines[0] || "yt-dlp failed";
      console.error("yt-dlp error:", err);
      reject(new Error(errLine));
    });
  });
}

const MAX_SECONDS = 185; // Shorts are up to 3 minutes
async function runYt(args, timeoutMs) {
  try {
    return await run(["--js-runtimes", "node", ...args], timeoutMs);
  } catch (e) {
    if (/no such option|unrecognized arguments/i.test(e.message)) return run(args, timeoutMs);
    throw e;
  }
}

app.post("/api/info", async (req, res) => {
  const url = (req.body && req.body.url || "").trim();
  if (!validYouTubeUrl(url)) return res.status(400).json({ error: "Please paste a valid YouTube Shorts link." });
  try {
    const out = await runYt(["-J", "--no-playlist", "--no-warnings", url]);
    const info = JSON.parse(out);
    if (info.duration && info.duration > MAX_SECONDS) {
      return res.status(422).json({ error: "This tool supports YouTube Shorts only (videos up to 3 minutes)." });
    }
    const best = {};
    (info.formats || []).forEach(f => {
      if (f.vcodec && f.vcodec !== "none" && f.height) {
        const size = f.filesize || f.filesize_approx || 0;
        if (!best[f.height] || size > best[f.height]) best[f.height] = size;
      }
    });
    const heights = Object.keys(best).map(Number).sort((a, b) => b - a).map(h => ({ height: h, size: best[h] || null }));
    res.json({
      title: info.title || "YouTube Short",
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      uploader: info.uploader || info.channel || null,
      heights
    });
  } catch (e) {
    console.error("info error:", e.message);
    res.status(422).json({ error: "No downloadable video found. Make sure it is a public YouTube Short." });
  }
});

app.get("/api/download", async (req, res) => {
  const url = (req.query.url || "").toString().trim();
  if (!validYouTubeUrl(url)) return res.status(400).send("Invalid link");
  const audio = req.query.type === "audio";
  let h = parseInt(req.query.h, 10);
  if (!(h >= 144 && h <= 4320)) h = 0;
  const id = crypto.randomBytes(8).toString("hex");
  const base = path.join(os.tmpdir(), "ys_" + id);
  const args = audio
    ? ["-x", "--audio-format", "mp3", "-f", "ba/b"]
    : ["-f", h ? `b[height<=${h}]/bv*[height<=${h}]+ba/b` : "b/bv*+ba", "--merge-output-format", "mp4"];
  try {
    await runYt([...args, "--match-filter", "duration<=" + MAX_SECONDS, "--no-playlist", "--no-warnings",
      "-o", base + ".%(ext)s", url], 280000);
    const file = fs.readdirSync(os.tmpdir()).find(f => f.startsWith("ys_" + id));
    if (!file) throw new Error("No file");
    const full = path.join(os.tmpdir(), file);
    const name = audio ? "youtube-short-audio" : "youtube-short" + (h ? "-" + h + "p" : "");
    res.download(full, name + path.extname(file), () => fs.unlink(full, () => {}));
  } catch (e) {
    console.error("download error:", e.message);
    res.status(500).send("Download failed: " + e.message);
  }
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log("Server running on port " + PORT));
