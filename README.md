# Quick Share

Quick Share lets a sender upload one file, choose its lifetime, and share a link or a 10-character code. Recipients can open the link (which pre-fills the code) or enter the code themselves. The API rejects expired shares and a background cleanup loop removes their objects and metadata automatically.

## Run locally

1. Copy `.env.example` to `.env` and adjust settings if needed.
2. Run `docker compose up --build`.
3. Open <http://localhost:8080>.

Local uploads are stored in the persistent `uploads` Docker volume. PostgreSQL metadata is stored in `postgres_data`. The API and UI are separate services. The API health check is at `/health`.

Storage follows `APP_ENV` by default: `local` uses local disk and `production` uses S3. You can override this with `STORAGE_BACKEND=local|s3`. For production provide `S3_BUCKET` and `AWS_REGION`. The S3 adapter uses the standard AWS credential chain (task/instance role recommended); access keys can be injected with environment variables for development. Use a managed PostgreSQL database and inject secrets through your deployment platform. Do not commit `.env`.

`MAX_UPLOAD_SIZE_MB` limits uploads. Expiration choices are 5, 10, 30, or 60 minutes; `DEFAULT_EXPIRY_MINUTES` selects the initial UI choice. The API rejects other durations. The cleanup worker runs in the API process every `CLEANUP_INTERVAL_SECONDS` seconds. A share is considered expired at its expiry timestamp, even before physical cleanup runs.

## Architecture

- `ui`: static HTML/CSS/JavaScript served by Nginx.
- `api`: FastAPI endpoints, validation, PostgreSQL share metadata, and expiration cleanup.
- Storage interface: local filesystem for development or S3 for production, selected by environment.
- `db`: PostgreSQL in Compose; use RDS or compatible managed PostgreSQL in AWS.

Files are uploaded using streaming multipart parsing into a temporary file while enforcing the configured size limit. Share codes are generated from a cryptographically secure alphanumeric alphabet and protected by a uniqueness constraint. Downloads use API streaming from the storage adapter. Expired records are claimed transactionally before deleting their objects, allowing cleanup to retry safely after storage errors.

## Useful endpoints

- `GET /health` — liveness and database check
- `POST /api/shares` — multipart upload (`file`, `expiry_minutes`)
- `GET /api/shares/{code}` — share metadata, or 404/410
- `GET /api/shares/{code}/download` — download, or 404/410

The API also serves OpenAPI documentation at `/docs`.
