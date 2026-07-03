// Minimal queue abstraction. Uses BullMQ + Redis when REDIS_URL is set,
// otherwise falls back to an in-memory queue (single-instance dev/prod).

import { randomUUID } from "node:crypto";

const jobs = new Map(); // id -> { id, data, status, progress, error, result }

class InMemoryQueue {
  constructor(processor, concurrency = 1) {
    this.processor = processor;
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
  }
  add(data) {
    const id = randomUUID();
    const record = { id, data, status: "queued", progress: 0, error: null, result: null, createdAt: Date.now() };
    jobs.set(id, record);
    this.pending.push(id);
    this._drain();
    return id;
  }
  get(id) { return jobs.get(id) ?? null; }
  _drain() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      const job = jobs.get(id);
      if (!job) continue;
      this.running++;
      this._run(job).finally(() => { this.running--; this._drain(); });
    }
  }
  async _run(job) {
    const update = (patch) => Object.assign(job, patch);
    try {
      update({ status: "processing" });
      const result = await this.processor(job.data, (progress, status) => {
        update({ progress: Math.max(0, Math.min(100, Math.round(progress))) });
        if (status) update({ status });
      });
      update({ status: "completed", progress: 100, result });
    } catch (err) {
      update({ status: "failed", error: err?.message ?? String(err) });
    }
  }
}

export async function createQueue({ processor, concurrency }) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return new InMemoryQueue(processor, concurrency);
  }
  const { Queue, Worker, QueueEvents } = await import("bullmq");
  const IORedis = (await import("ioredis")).default;
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queueName = "shortclip";
  const q = new Queue(queueName, { connection });
  const events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();

  new Worker(queueName, async (job) => {
    return await processor(job.data, async (progress, status) => {
      await job.updateProgress({ progress, status });
    });
  }, { connection, concurrency });

  return {
    async add(data) {
      const job = await q.add("process", data, { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 });
      return job.id;
    },
    async get(id) {
      const job = await q.getJob(id);
      if (!job) return null;
      const state = await job.getState();
      const map = { waiting: "queued", delayed: "queued", active: "processing", completed: "completed", failed: "failed" };
      const progressRaw = job.progress;
      const progress = typeof progressRaw === "object" && progressRaw ? progressRaw.progress ?? 0 : (typeof progressRaw === "number" ? progressRaw : 0);
      const status = typeof progressRaw === "object" && progressRaw?.status ? progressRaw.status : (map[state] ?? "queued");
      return {
        id: job.id,
        status,
        progress,
        error: job.failedReason ?? null,
        result: job.returnvalue ?? null,
      };
    },
  };
}
