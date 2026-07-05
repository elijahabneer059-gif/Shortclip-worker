// The actual video pipeline: yt-dlp → ffmpeg → whisper → cut vertical clips.

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";

function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function ffprobeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nokey=1:noprint_format=1", file,
  ]);
  return parseFloat(stdout.trim());
}

// Pick evenly-spaced clip windows from [10%, 90%] of the source.
function pickWindows(duration, clipSeconds, count) {
  const usable = Math.max(0, duration - 20);
  if (usable < clipSeconds) return [{ start: 0, end: Math.min(duration, clipSeconds) }];
  const windows = [];
  const step = usable / (count + 1);
  for (let i = 1; i <= count; i++) {
    const start = 10 + step * i - clipSeconds / 2;
    const end = Math.min(duration, start + clipSeconds);
    windows.push({ start: Math.max(0, start), end });
  }
  return windows;
}

async function transcribe(audioPath) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const openai = new OpenAI({ apiKey: key });
  try {
    const res = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
    return res; // { text, segments: [{start,end,text}], ... }
  } catch (err) {
    console.warn("Whisper failed:", err?.message);
    return null;
  }
}

function segmentsWithin(transcript, start, end) {
  if (!transcript?.segments) return [];
  return transcript.segments.filter((s) => s.end >= start && s.start <= end);
}

function titleFromSegments(segs, fallback) {
  const text = segs.map((s) => s.text).join(" ").trim();
  if (!text) return fallback;
  const words = text.split(/\s+/).slice(0, 8).join(" ");
  return words.replace(/[.,;:!?]+$/, "");
}

export async function processJob(data, onProgress) {
  const { project_id, source_url, clip_duration, callback_url } = data;
  const clipSeconds = Math.max(5, Math.min(90, Number(clip_duration) || 30));
  const workDir = await mkdtemp(path.join(tmpdir(), "shortclip-"));

  const report = async (status, progress, extra = {}) => {
    onProgress?.(progress, status);
    if (!callback_url) return;
    try {
      const { hmacHex } = await import("./hmac.js");
      const payload = { project_id, status, progress, ...extra };
      const body = JSON.stringify(payload);
      const signature = hmacHex(process.env.WORKER_SHARED_SECRET, body);
      await fetch(callback_url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shortify-signature": signature },
        body,
      });
    } catch (err) {
      console.warn("callback failed:", err?.message);
    }
  };

  try {
    await report("downloading", 5);
    const sourceFile = path.join(workDir, "source.mp4");
    // Merge best video+audio, fall back to a progressive mp4.
    const ytdlpArgs = [
      "-f", "bv*+ba/b",
      "--merge-output-format", "mp4",
      "--no-warnings",
      // Impersonate a real browser client; helps with the "sign in to
      // confirm you're not a bot" check on many videos.
      "--extractor-args", "youtube:player_client=web,web_safari,android",
      "-o", sourceFile,
    ];
    // If cookies were provided via YOUTUBE_COOKIES (materialized to a file by
    // entrypoint.sh) or YOUTUBE_COOKIES_PATH points at an existing file,
    // pass them to yt-dlp so it can authenticate as a signed-in user.
    const cookiesPath = process.env.YOUTUBE_COOKIES_PATH;
    if (cookiesPath) {
      try {
        await stat(cookiesPath);
        ytdlpArgs.push("--cookies", cookiesPath);
      } catch {
        console.warn(`YOUTUBE_COOKIES_PATH set but ${cookiesPath} not found`);
      }
    }
    ytdlpArgs.push(source_url);
    await run("yt-dlp", ytdlpArgs, {
      onStderr: (s) => {
        const m = s.match(/(\d+(?:\.\d+)?)%/);
        if (m) {
          const pct = 5 + Math.min(30, parseFloat(m[1]) * 0.3);
          onProgress?.(pct, "downloading");
        }
      },
    });

    await report("processing", 40);
    const duration = await ffprobeDuration(sourceFile);
    if (!isFinite(duration) || duration < clipSeconds) {
      throw new Error(`Source video too short (${duration}s) for ${clipSeconds}s clips`);
    }

    // Extract 16kHz mono wav for whisper.
    const audioFile = path.join(workDir, "audio.wav");
    await run("ffmpeg", ["-y", "-i", sourceFile, "-vn", "-ac", "1", "-ar", "16000", audioFile]);

    await report("processing", 55);
    const transcript = await transcribe(audioFile);

    await report("rendering", 65);
    const count = Math.max(1, Math.min(6, Number(process.env.CLIPS_PER_VIDEO ?? 3)));
    const windows = pickWindows(duration, clipSeconds, count);

    const clips = [];
    for (let i = 0; i < windows.length; i++) {
      const { start, end } = windows[i];
      const outFile = path.join(workDir, `clip_${i + 1}.mp4`);
      // 9:16 vertical: scale to fill 1080x1920, center crop.
      const vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
      await run("ffmpeg", [
        "-y",
        "-ss", String(start),
        "-to", String(end),
        "-i", sourceFile,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        outFile,
      ]);

      const segs = segmentsWithin(transcript, start, end);
      const title = titleFromSegments(segs, `Clip ${i + 1}`);
      const description = segs.map((s) => s.text).join(" ").trim().slice(0, 240) || null;

      const bytes = await readFile(outFile);
      const fileStat = await stat(outFile);
      // Return as data URL. For production, upload to S3/R2/Cloudinary and
      // return the public URL instead — this keeps callback payloads small.
      const base64 = bytes.toString("base64");
      const video_url = `data:video/mp4;base64,${base64}`;

      clips.push({
        title,
        description,
        duration: Math.round(end - start),
        start_time: Math.round(start),
        end_time: Math.round(end),
        video_url,
        thumbnail_url: null,
        hashtags: null,
        _bytes: fileStat.size,
      });

      const rProgress = 65 + Math.round(((i + 1) / windows.length) * 30);
      await report("rendering", rProgress);
    }

    await report("completed", 100, {
      clips: clips.map(({ _bytes, ...c }) => c),
    });

    return { clips: clips.length };
  } catch (err) {
    await report("failed", 0, { error_message: err?.message ?? String(err) });
    throw err;
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
