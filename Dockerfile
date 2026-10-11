# Quorum — multi-agent verified research pipeline.
# The container needs OPENAI_API_KEY (+ OPENAI_BASE_URL / models) and
# TAVILY_API_KEY passed as environment variables at runtime; never bake keys in.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY evals/ evals/
COPY scripts/ scripts/

RUN addgroup -S quorum && adduser -S quorum -G quorum
USER quorum

EXPOSE 8080
CMD ["node", "src/server.js"]
