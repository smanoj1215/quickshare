import asyncio
import logging
import os
import re
import secrets
import shutil
import string
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import quote

import boto3
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import DateTime, Integer, String, create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("quickshare")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:////tmp/quickshare.db")
MAX_BYTES = int(os.getenv("MAX_UPLOAD_SIZE_MB", "100")) * 1024 * 1024
EXPIRY_OPTIONS_MINUTES = (5, 10, 30, 60)
DEFAULT_EXPIRY_MINUTES = int(os.getenv("DEFAULT_EXPIRY_MINUTES", "30"))
if DEFAULT_EXPIRY_MINUTES not in EXPIRY_OPTIONS_MINUTES:
    raise RuntimeError("DEFAULT_EXPIRY_MINUTES must be one of 5, 10, 30, or 60")
CLEANUP_INTERVAL = max(10, int(os.getenv("CLEANUP_INTERVAL_SECONDS", "60")))
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8080").rstrip("/")
CODE_CHARS = string.ascii_uppercase + string.digits
CODE_RE = re.compile(r"^[A-Z0-9]{10}$")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Share(Base):
    __tablename__ = "shares"
    code: Mapped[str] = mapped_column(String(10), primary_key=True)
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


class Storage:
    def put(self, key: str, local_path: str) -> None: raise NotImplementedError
    def open(self, key: str): raise NotImplementedError
    def delete(self, key: str) -> None: raise NotImplementedError


class LocalStorage(Storage):
    def __init__(self):
        self.root = Path(os.getenv("LOCAL_STORAGE_PATH", "/data/uploads"))
        self.root.mkdir(parents=True, exist_ok=True)
    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents: raise ValueError("Invalid storage key")
        return path
    def put(self, key: str, local_path: str) -> None:
        dest = self._path(key); dest.parent.mkdir(parents=True, exist_ok=True)
        # /tmp and a mounted Docker volume can be different filesystems, so replace()
        # is not safe here. Copy to a sibling temp file then atomically publish it.
        staged = dest.with_name(dest.name + ".staging")
        shutil.copyfile(local_path, staged)
        os.replace(staged, dest)
    def open(self, key: str): return open(self._path(key), "rb")
    def delete(self, key: str) -> None:
        try: self._path(key).unlink()
        except FileNotFoundError: pass


class S3Storage(Storage):
    def __init__(self):
        bucket = os.getenv("S3_BUCKET")
        if not bucket: raise RuntimeError("S3_BUCKET is required when STORAGE_BACKEND=s3")
        self.bucket = bucket
        self.client = boto3.client("s3", region_name=os.getenv("AWS_REGION"))
    def put(self, key: str, local_path: str) -> None: self.client.upload_file(local_path, self.bucket, key)
    def open(self, key: str): return self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
    def delete(self, key: str) -> None: self.client.delete_object(Bucket=self.bucket, Key=key)


APP_ENV = os.getenv("APP_ENV", "local").lower()
STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "s3" if APP_ENV in {"prod", "production"} else "local").lower()
if STORAGE_BACKEND not in {"local", "s3"}:
    raise RuntimeError("STORAGE_BACKEND must be 'local' or 's3'")
storage: Storage = S3Storage() if STORAGE_BACKEND == "s3" else LocalStorage()


def now_utc() -> datetime: return datetime.now(timezone.utc)


def get_share(code: str) -> Share:
    code = code.strip().upper()
    if not CODE_RE.fullmatch(code): raise HTTPException(404, "Share not found")
    with SessionLocal() as db: share = db.get(Share, code)
    if share is None: raise HTTPException(404, "Share not found")
    if share.expires_at <= now_utc(): raise HTTPException(410, "This share has expired")
    return share


def cleanup_expired() -> None:
    # Delete the object first. Keep metadata if storage deletion fails so a later pass retries.
    with SessionLocal() as db:
        expired = db.scalars(select(Share).where(Share.expires_at <= now_utc()).limit(100)).all()
        for share in expired:
            try:
                storage.delete(share.storage_key)
                db.delete(share)
                db.commit()
                log.info("Expired share removed", extra={"code": share.code})
            except Exception:
                db.rollback()
                log.exception("Expired share cleanup failed")


async def cleanup_loop():
    while True:
        try: await asyncio.to_thread(cleanup_expired)
        except Exception: log.exception("Cleanup pass failed")
        await asyncio.sleep(CLEANUP_INTERVAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()
    try: await task
    except asyncio.CancelledError: pass


app = FastAPI(title="Quick Share API", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health():
    try:
        with engine.connect() as conn: conn.exec_driver_sql("SELECT 1")
        return {"status": "ok"}
    except Exception as exc:
        log.exception("Health check failed")
        raise HTTPException(503, "Database unavailable") from exc


@app.get("/api/config")
def config():
    return {"max_upload_size_mb": int(MAX_BYTES / (1024 * 1024)), "default_expiry_minutes": DEFAULT_EXPIRY_MINUTES, "expiry_options_minutes": EXPIRY_OPTIONS_MINUTES}


@app.post("/api/shares")
async def create_share(file: UploadFile = File(...), expiry_minutes: int = Form(DEFAULT_EXPIRY_MINUTES)):
    if expiry_minutes not in EXPIRY_OPTIONS_MINUTES:
        raise HTTPException(400, "Expiry must be 5, 10, 30, or 60 minutes")
    filename = Path(file.filename or "file").name[:255]
    if not filename or filename in {".", ".."}: filename = "file"
    content_type = (file.content_type or "application/octet-stream")[:255]
    size = 0
    temp = tempfile.NamedTemporaryFile(prefix="quickshare-", delete=False)
    temp_path = temp.name
    try:
        with temp:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES: raise HTTPException(413, f"File exceeds the {MAX_BYTES // (1024 * 1024)} MB limit")
                temp.write(chunk)
        if size == 0: raise HTTPException(400, "Empty files cannot be shared")
        for _ in range(5):
            code = "".join(secrets.choice(CODE_CHARS) for _ in range(10))
            created = now_utc()
            share = Share(code=code, storage_key=secrets.token_hex(24), filename=filename, content_type=content_type, size=size, created_at=created, expires_at=created + timedelta(minutes=expiry_minutes))
            with SessionLocal() as db:
                if db.get(Share, code): continue
                try:
                    storage.put(share.storage_key, temp_path)
                    db.add(share); db.commit()
                    return {"code": code, "url": f"{PUBLIC_BASE_URL}/?code={code}", "filename": filename, "size": size, "expires_at": share.expires_at.isoformat()}
                except IntegrityError:
                    db.rollback()
                    try: storage.delete(share.storage_key)
                    except Exception: log.exception("Failed to clean up colliding code object")
                    continue
                except Exception:
                    db.rollback()
                    try: storage.delete(share.storage_key)
                    except Exception: log.exception("Failed to rollback stored object")
                    raise
        raise HTTPException(503, "Could not allocate a share code; try again")
    finally:
        try: os.unlink(temp_path)
        except FileNotFoundError: pass
        await file.close()


@app.get("/api/shares/{code}")
def share_info(code: str):
    share = get_share(code)
    return {"code": share.code, "filename": share.filename, "size": share.size, "expires_at": share.expires_at.isoformat(), "download_url": f"/api/shares/{share.code}/download"}


@app.get("/api/shares/{code}/download")
def download(code: str):
    share = get_share(code)
    try: body = storage.open(share.storage_key)
    except Exception as exc:
        log.exception("Object download failed")
        raise HTTPException(502, "File storage is temporarily unavailable") from exc
    safe_filename = quote(share.filename, safe="")
    return StreamingResponse(body, media_type=share.content_type, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}", "Content-Length": str(share.size), "Cache-Control": "no-store"})
