const fs = require("fs");
const path = require("path");
const net = require("net");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.TCP_LAB_PORT) || 4200;
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "tcp-lab.ndjson");
const MAX_MEMORY_LOGS = 300;

function ensureLogStore() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "");
  }
}

function normalizeHost(value) {
  if (typeof value !== "string") {
    return DEFAULT_HOST;
  }

  const trimmed = value.trim();
  return trimmed || DEFAULT_HOST;
}

function normalizePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }

  return port;
}

function makeId(prefix, sequence) {
  return `${prefix}-${Date.now()}-${sequence}`;
}

function bufferFields(buffer) {
  const utf8 = buffer.toString("utf8");
  return {
    bytes: buffer.length,
    utf8,
    hex: buffer.toString("hex"),
  };
}

function socketAddresses(socket) {
  return {
    localAddress: socket.localAddress || null,
    localPort: socket.localPort || null,
    remoteAddress: socket.remoteAddress || null,
    remotePort: socket.remotePort || null,
  };
}

function serializeSocket(info) {
  return {
    id: info.id,
    role: info.role,
    label: info.label,
    status: info.status,
    localAddress: info.localAddress,
    localPort: info.localPort,
    remoteAddress: info.remoteAddress,
    remotePort: info.remotePort,
    bytesRead: info.bytesRead,
    bytesWritten: info.bytesWritten,
    openedAt: info.openedAt,
    endedAt: info.endedAt,
    closedAt: info.closedAt,
    destroyed: info.destroyed,
    readyState: info.readyState,
    lastError: info.lastError,
  };
}

class TcpLabManager {
  constructor() {
    ensureLogStore();

    this.host = DEFAULT_HOST;
    this.port = DEFAULT_PORT;
    this.server = null;
    this.serverStartedAt = null;
    this.logs = [];
    this.logSequence = 0;
    this.socketSequence = 0;
    this.socketEntries = new Map();
    this.streams = new Set();
  }

  emit(event) {
    const record = {
      id: makeId("lab", ++this.logSequence),
      at: new Date().toISOString(),
      ...event,
    };

    this.logs.push(record);
    if (this.logs.length > MAX_MEMORY_LOGS) {
      this.logs.shift();
    }

    fs.appendFile(LOG_FILE, `${JSON.stringify(record)}\n`, () => {});
    this.broadcast({ type: "log", event: record });

    return record;
  }

  broadcast(payload) {
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;

    for (const res of this.streams) {
      res.write(chunk);
    }
  }

  pushState() {
    this.broadcast({ type: "state", state: this.getState() });
  }

  getState() {
    const sockets = Array.from(this.socketEntries.values())
      .map((entry) => serializeSocket(entry.info))
      .sort((left, right) => {
        const leftAt = left.openedAt || left.closedAt || "";
        const rightAt = right.openedAt || right.closedAt || "";
        return rightAt.localeCompare(leftAt);
      });

    return {
      host: this.host,
      port: this.port,
      listening: Boolean(this.server),
      serverStartedAt: this.serverStartedAt,
      logFile: LOG_FILE,
      sockets,
      logs: this.logs,
    };
  }

  registerStream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });

    res.write(`data: ${JSON.stringify({ type: "state", state: this.getState() })}\n\n`);
    this.streams.add(res);

    req.on("close", () => {
      this.streams.delete(res);
    });
  }

  createSocketInfo(role, label) {
    return {
      id: makeId("sock", ++this.socketSequence),
      role,
      label,
      status: "opening",
      localAddress: null,
      localPort: null,
      remoteAddress: null,
      remotePort: null,
      bytesRead: 0,
      bytesWritten: 0,
      openedAt: null,
      endedAt: null,
      closedAt: null,
      destroyed: false,
      readyState: "opening",
      lastError: null,
    };
  }

  syncSocketInfo(info, socket) {
    const addresses = socketAddresses(socket);
    info.localAddress = addresses.localAddress;
    info.localPort = addresses.localPort;
    info.remoteAddress = addresses.remoteAddress;
    info.remotePort = addresses.remotePort;
    info.bytesRead = socket.bytesRead;
    info.bytesWritten = socket.bytesWritten;
    info.destroyed = socket.destroyed;
    info.readyState = socket.readyState || (socket.destroyed ? "closed" : "open");
  }

  attachSocket(socket, info) {
    const entry = {
      info,
      socket,
    };

    this.socketEntries.set(info.id, entry);
    this.syncSocketInfo(info, socket);

    socket.on("data", (buffer) => {
      this.syncSocketInfo(info, socket);
      this.emit({
        category: "socket",
        action: "data",
        socketId: info.id,
        role: info.role,
        label: info.label,
        ...socketAddresses(socket),
        ...bufferFields(buffer),
        detail: `${info.label} received ${buffer.length}B.`,
      });
      this.pushState();
    });

    socket.on("end", () => {
      info.status = "half-closed";
      info.endedAt = new Date().toISOString();
      this.syncSocketInfo(info, socket);
      this.emit({
        category: "socket",
        action: "end",
        socketId: info.id,
        role: info.role,
        label: info.label,
        ...socketAddresses(socket),
        detail: `${info.label} observed FIN from the peer.`,
      });
      this.pushState();
    });

    socket.on("close", (hadError) => {
      info.status = "closed";
      info.closedAt = new Date().toISOString();
      this.syncSocketInfo(info, socket);
      entry.socket = null;
      this.emit({
        category: "socket",
        action: "close",
        socketId: info.id,
        role: info.role,
        label: info.label,
        hadError,
        ...socketAddresses(socket),
        detail: `${info.label} closed.`,
      });
      this.pushState();
    });

    socket.on("error", (error) => {
      info.status = "error";
      info.lastError = error.message;
      this.syncSocketInfo(info, socket);
      this.emit({
        category: "socket",
        action: "error",
        socketId: info.id,
        role: info.role,
        label: info.label,
        code: error.code || null,
        message: error.message,
        ...socketAddresses(socket),
        detail: `${info.label} emitted an error.`,
      });
      this.pushState();
    });

    return entry;
  }

  async startServer(options = {}) {
    if (this.server) {
      throw new Error("The TCP lab server is already running.");
    }

    this.host = normalizeHost(options.host);
    this.port = normalizePort(options.port, this.port);

    const server = net.createServer((socket) => {
      const info = this.createSocketInfo("server-peer", "Accepted peer");
      info.status = "open";
      info.openedAt = new Date().toISOString();
      this.attachSocket(socket, info);
      this.syncSocketInfo(info, socket);

      this.emit({
        category: "server",
        action: "accepted",
        socketId: info.id,
        role: info.role,
        label: info.label,
        ...socketAddresses(socket),
        detail: `Accepted TCP connection from ${socket.remoteAddress}:${socket.remotePort}.`,
      });
      this.pushState();
    });

    server.on("error", (error) => {
      this.emit({
        category: "server",
        action: "error",
        code: error.code || null,
        message: error.message,
        host: this.host,
        port: this.port,
        detail: "The TCP lab server emitted an error.",
      });
      this.pushState();
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.serverStartedAt = new Date().toISOString();
    this.emit({
      category: "server",
      action: "listening",
      host: this.host,
      port: this.port,
      detail: `Listening on ${this.host}:${this.port}.`,
    });
    this.pushState();

    return this.getState();
  }

  async stopServer() {
    if (!this.server) {
      return this.getState();
    }

    const server = this.server;
    const openEntries = Array.from(this.socketEntries.values()).filter(
      (entry) => entry.socket && !entry.socket.destroyed,
    );

    for (const entry of openEntries) {
      entry.socket.end();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    for (const entry of openEntries) {
      if (entry.socket && !entry.socket.destroyed) {
        entry.socket.destroy();
      }
    }

    this.server = null;
    this.serverStartedAt = null;
    this.emit({
      category: "server",
      action: "stopped",
      host: this.host,
      port: this.port,
      detail: `Stopped listening on ${this.host}:${this.port}.`,
    });
    this.pushState();

    return this.getState();
  }

  async connectManagedClient(options = {}) {
    const host = normalizeHost(options.host || this.host);
    const port = normalizePort(options.port, this.port);
    const label = typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "Managed client";

    const socket = new net.Socket();
    const info = this.createSocketInfo("managed-client", label);
    const entry = this.attachSocket(socket, info);

    this.emit({
      category: "client",
      action: "connect-request",
      socketId: info.id,
      role: info.role,
      label: info.label,
      host,
      port,
      detail: `${info.label} is connecting to ${host}:${port}.`,
    });
    this.pushState();

    await new Promise((resolve, reject) => {
      let settled = false;

      socket.once("connect", () => {
        info.status = "open";
        info.openedAt = new Date().toISOString();
        this.syncSocketInfo(info, socket);
        this.emit({
          category: "client",
          action: "connected",
          socketId: info.id,
          role: info.role,
          label: info.label,
          ...socketAddresses(socket),
          detail: `${info.label} connected to ${host}:${port}.`,
        });
        this.pushState();
        settled = true;
        resolve();
      });

      socket.once("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        entry.socket = null;
        reject(error);
      });

      socket.connect(port, host);
    });

    return this.getState();
  }

  async send(socketId, text) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket || entry.socket.destroyed) {
      throw new Error("The selected socket is not writable.");
    }

    const payload = Buffer.from(typeof text === "string" ? text : String(text || ""), "utf8");
    if (payload.length === 0) {
      throw new Error("Message must not be empty.");
    }

    await new Promise((resolve, reject) => {
      entry.socket.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.syncSocketInfo(entry.info, entry.socket);
    this.emit({
      category: "socket",
      action: "write",
      socketId: entry.info.id,
      role: entry.info.role,
      label: entry.info.label,
      ...socketAddresses(entry.socket),
      ...bufferFields(payload),
      detail: `${entry.info.label} sent ${payload.length}B.`,
    });
    this.pushState();

    return this.getState();
  }

  async end(socketId) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket || entry.socket.destroyed) {
      throw new Error("The selected socket is not open.");
    }

    entry.info.status = "ending";
    this.syncSocketInfo(entry.info, entry.socket);
    entry.socket.end();
    this.emit({
      category: "socket",
      action: "end-request",
      socketId: entry.info.id,
      role: entry.info.role,
      label: entry.info.label,
      ...socketAddresses(entry.socket),
      detail: `${entry.info.label} sent FIN with socket.end().`,
    });
    this.pushState();

    return this.getState();
  }

  async destroy(socketId) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket || entry.socket.destroyed) {
      throw new Error("The selected socket is not open.");
    }

    this.syncSocketInfo(entry.info, entry.socket);
    entry.socket.destroy();
    this.emit({
      category: "socket",
      action: "destroy",
      socketId: entry.info.id,
      role: entry.info.role,
      label: entry.info.label,
      ...socketAddresses(entry.socket),
      detail: `${entry.info.label} destroyed the socket.`,
    });
    this.pushState();

    return this.getState();
  }

  openSocketOptions() {
    return Array.from(this.socketEntries.values())
      .filter((entry) => entry.socket && !entry.socket.destroyed)
      .map((entry) => serializeSocket(entry.info));
  }
}

function createTcpLabManager() {
  return new TcpLabManager();
}

module.exports = {
  DEFAULT_TCP_LAB_HOST: DEFAULT_HOST,
  DEFAULT_TCP_LAB_PORT: DEFAULT_PORT,
  TCP_LAB_LOG_FILE: LOG_FILE,
  createTcpLabManager,
};
