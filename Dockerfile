# StoryCut backend — Hugging Face Spaces (Docker, free tier)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# ffmpeg is required for all media processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend

# HF Spaces routes to port 7860
ENV PORT=7860 HOST=0.0.0.0

EXPOSE 7860

CMD ["python", "-m", "backend.app"]
