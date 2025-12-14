FROM node:20-alpine

WORKDIR /app

# Copy package.json and install dependencies for caching
COPY package.json ./
RUN npm install --omit=dev

# Copy project files
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm","start"]
