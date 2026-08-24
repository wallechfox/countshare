FROM node:20-alpine

RUN apk add --no-cache zip

WORKDIR /app

COPY app.js .
COPY public/ ./public/

VOLUME /files
VOLUME /data

EXPOSE 8000

CMD ["node", "app.js"]
