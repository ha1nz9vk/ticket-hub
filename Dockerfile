
# Build TicketHub Backend
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@12.11.2

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @tickethub/shared build \
    && test -f packages/shared/dist/index.js \
    && test -f packages/shared/dist/index.d.ts

RUN pnpm --filter @tickethub/api build

# Run compiled API
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app /app

EXPOSE 4000

CMD ["node", "apps/api/dist/main.js"]
