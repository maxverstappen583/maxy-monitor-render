# Dockerfile for Render
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package.json package.json
RUN npm install --production

# Copy app source
COPY . .

# Create runtime directory for DB
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app

USER node

# Render sets PORT environment variable; default to 3000 locally
ENV PORT=3000

EXPOSE ${PORT}

CMD ["npm", "start"]
