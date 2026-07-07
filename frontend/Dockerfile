# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_API_URL
ARG VITE_WS_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# --- Production stage: serve the static build with nginx ---
FROM nginx:alpine AS production
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
