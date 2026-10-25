# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web-build
WORKDIR /frontend
COPY package*.json tsconfig.json vite.config.ts ./
RUN npm install --no-audit --no-fund
COPY index.html style.css config.js app.ts ./
COPY src ./src
COPY res ./res
RUN npm run build

FROM python:3.12-slim AS production
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd -r -u 10001 appuser
COPY backend ./backend
COPY config.js ./config.js
COPY --from=web-build /frontend/dist ./dist
USER appuser
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]
