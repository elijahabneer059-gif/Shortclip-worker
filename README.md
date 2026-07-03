# shortclip-worker

External processing service for **Shortify AI**. Handles yt-dlp downloads,
FFmpeg vertical rendering, and OpenAI Whisper transcription.

## Endpoints
- `GET  /health` — liveness probe
- `POST /job` — enqueue a job (HMAC-signed)
- `GET  /job/:id` — read job status/progress

## Env vars
See `.env.example`. Required: `WORKER_SHARED_SECRET` (must match Lovable).
Optional: `OPENAI_API_KEY`, `REDIS_URL`, `CLIPS_PER_VIDEO`, `WORKER_CONCURRENCY`.

## Deploy on Render
1. Push this folder to GitHub.
2. Render → New + → Web Service → connect the repo.
3. Runtime: Docker. Plan: Standard or larger (ffmpeg is CPU-heavy).
4. Env vars: `WORKER_SHARED_SECRET` (same as Lovable), `OPENAI_API_KEY`.
5. Health check: `/health`.
6. Deploy, then set Lovable `WORKER_URL` secret to `https://<service>.onrender.com/job`.

## Deploy on Railway
1. New Project → Deploy from GitHub repo.
2. Railway auto-detects the Dockerfile.
3. Add the same env vars.
4. Generate a public domain, set `WORKER_URL` = `https://<service>.up.railway.app/job`.

## Local dev
```bash
cp .env.example .env
npm install
npm run dev
