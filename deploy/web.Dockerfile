# Edge proxy for the compose `full` profile.
# Phase 3: nginx reverse-proxies the legacy portal (served by api at /app)
# and the bot-owned public surfaces. No Node at runtime. Phase 4 will add
# a Vite build stage in front of the same nginx.conf.

FROM nginx:alpine

COPY deploy/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
