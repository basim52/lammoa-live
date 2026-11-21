# Docker image for Hugging Face Spaces / Render / Fly / Railway.
# Secrets (GEMINI_API_KEY, CONTROL_TOKEN) are set in the host's secret settings, never in this file.
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7860 STATE_FILE=/tmp/lammoa-state.json
WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
USER node
EXPOSE 7860
CMD ["node", "src/server.js"]
