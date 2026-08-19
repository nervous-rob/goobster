# Edge proxy for the compose `full` profile.
# Phase 4: nginx still reverse-proxies /app (legacy) and /app/next (React,
# flag-gated in the api process) to api. No Node at runtime. The Vite
# build lives in deploy/api.Dockerfile so webapp.nextClient can serve the
# SPA without flipping /app.

FROM nginx:alpine

COPY deploy/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
