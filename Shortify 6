import "dotenv/config";
import express from "express";
import { hmacHex, timingSafeEqualHex } from "./hmac.js";
import { createQueue } from "./queue.js";
import { processJob } from "./pipeline.js";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.WORKER_SHARED_SECRET;
if (!SECRET) {
  console.error("FATAL: WORKER_SHARED_SECRET is required");
  process.exit(1);
}

const queue = await createQueue({
  processor: processJob,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
});

const app = express();

// Capture raw body for HMAC verification.
app.use("/job", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post("/job", async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body ?? {});
    const signature = req.header("x-shortify-signature") ?? "";
    const expected = hmacHex(SECRET, raw);
    if (!signature || !timingSafeEqualHex(signature, expected)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    const payload = JSON.parse(raw);
    if (!payload.project_id || !payload.source_url) {
      return res.status(400).json({ error: "project_id and source_url required" });
    }
    const jobId = await queue.add(payload);
    res.status(202).json({ job_id: jobId });
  } catch (err) {
    console.error("POST /job failed:", err);
    res.status(500).json({ error: err?.message ?? "internal error" });
  }
});

app.get("/job/:id", async (req, res) => {
  const job = await queue.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress ?? 0,
    error: job.error ?? null,
  });
});

app.listen(PORT, () => {
  console.log(`shortclip-worker listening on :${PORT}`);
});
