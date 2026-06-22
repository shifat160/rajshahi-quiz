FROM node:20-alpine

WORKDIR /app

# Pure Node stdlib — no dependencies to install.
COPY server.js ./
COPY public ./public
COPY content ./content

ENV DATA_DIR=/app/data
ENV PORT=8080
RUN mkdir -p /app/data

EXPOSE 8080

# Set ADMIN_TOKEN to enable /api/reset, /api/export and the staff page.
# ENV ADMIN_TOKEN=changeme

CMD ["node", "server.js"]
