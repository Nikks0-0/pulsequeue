import http from "http";
import { app } from "./app";
import { logger } from "./lib/logger";
import { attachWebSocketGateway } from "./ws/gateway";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;

const server = http.createServer(app);
attachWebSocketGateway(server);

server.listen(PORT, () => {
  logger.info(`PulseQueue API listening on port ${PORT}`);
});
