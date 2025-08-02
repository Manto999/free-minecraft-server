# Use Node.js 18 with Alpine Linux
FROM node:18-alpine

# Install build dependencies, Java, and runtime dependencies
RUN apk add --no-cache \
    openjdk21-jre \
    curl \
    bash \
    python3 \
    make \
    g++ \
    cmake \
    linux-headers \
    libc6-compat \
    && rm -rf /var/cache/apk/*

# Verify Java installation
RUN java -version

# Set working directory
WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package*.json ./

# Install Node.js dependencies with fallback
RUN npm ci --only=production || npm install --only=production

# Copy application code
COPY . .

# Create minecraft-server directory and set permissions
RUN mkdir -p minecraft-server/plugins && \
    chmod -R 755 minecraft-server

# Expose ports
EXPOSE 3000 25565 19132

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV MINECRAFT_PORT=25565
ENV BEDROCK_PORT=19132
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk
ENV PATH=$JAVA_HOME/bin:$PATH

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
