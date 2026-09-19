FROM mcr.microsoft.com/playwright:v1.63.0-jammy
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends xdg-utils \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 3000
CMD ["node", "src/server.js"]
