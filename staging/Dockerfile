# ============================================================
# THE DNA LEAGUE — Dockerfile
# Serves the static app via nginx (Alpine Linux base)
# Build:  docker build -t dna-league .
# Run:    docker run -p 8080:80 dna-league
# ============================================================

# Stage 1: use a minimal nginx image on Alpine Linux
# Alpine is the default for Red Hat / security-conscious builds
# because it has a tiny attack surface (~5 MB base image)
FROM nginx:alpine

# Remove the default nginx welcome page
RUN rm -rf /usr/share/nginx/html/*

# Copy static app files into the nginx web root
COPY index.html    /usr/share/nginx/html/
COPY draft.html    /usr/share/nginx/html/
COPY fa-draft.html /usr/share/nginx/html/
COPY css/          /usr/share/nginx/html/css/
COPY js/           /usr/share/nginx/html/js/

# Copy our custom nginx config (routing + security headers)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 (standard HTTP — reverse proxy handles TLS in prod)
EXPOSE 80

# nginx starts automatically via the base image CMD
