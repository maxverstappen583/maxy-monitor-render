# Use official Node.js LTS (stable & fast)
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files first (better caching)
COPY package.json package-lock.json* ./

# Install only production deps
RUN npm install --omit=dev

# Copy rest of the project
COPY . .

# Render provides PORT automatically
ENV NODE_ENV=production

# Expose the port (Render maps it)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
