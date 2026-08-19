# Edge proxy for the compose `full` profile.
# Phase 4 flip: nginx reverse-proxies /app (React SPA after build:web) to
# api. No Node at runtime. The Vite build lives in deploy/api.Dockerfile.

FROM nginx:alpine

COPY deploy/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
