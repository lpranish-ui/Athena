# Athena API — Node + poppler.
#
# poppler-utils ships `pdftotext`, which extracts text from PDFs of ANY size
# with tiny memory use (the plain Node buildpack could not install system
# packages, which is why very large / scanned books failed there).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY sql ./sql
COPY data ./data

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "src/index.js"]
