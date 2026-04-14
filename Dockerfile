FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 7860
ENV PORT=7860
CMD ["node", "server.js"]
