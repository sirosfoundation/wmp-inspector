FROM node:22-slim AS build

WORKDIR /app

ARG BUILD_SHA=dev

# Copy workspace root
COPY package.json package-lock.json* ./

# Copy package manifests
COPY packages/frontend/package.json packages/frontend/
COPY packages/backend/package.json packages/backend/

# Install all dependencies
RUN npm install

# Copy source
COPY packages/frontend/ packages/frontend/
COPY packages/backend/ packages/backend/

# Build frontend then backend
RUN BUILD_SHA=${BUILD_SHA} npm run build --workspace=packages/frontend
RUN npm run build --workspace=packages/backend

# --- Production image ---
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# Install production deps only
RUN npm install --omit=dev

# Copy built artifacts
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/packages/frontend/dist packages/frontend/dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "packages/backend/dist/index.js"]
