FROM oven/bun:1

WORKDIR /app

COPY package.json ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["bun", "run", "index.ts"]
