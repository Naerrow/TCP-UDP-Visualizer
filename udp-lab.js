const fs = require("fs");
const path = require("path");
const dgram = require("dgram");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.UDP_LAB_PORT) || 4301;
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "udp-lab.ndjson");
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
    throw new Error("포트는 1 이상 65535 이하의 정수여야 한다.");
  }

  return port;
}

function normalizeBindPort(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("바인드 포트는 0 이상 65535 이하의 정수여야 한다.");
  }

  return port;
}

function resolveTargetPort(value, fallback) {
  if (value === undefined || value === null || value === "") {
    if (fallback) {
      return fallback;
    }
    throw new Error("대상 포트를 입력해야 한다.");
  }

  return normalizePort(value);
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

function localSocketAddress(socket) {
  try {
    const address = socket.address();
    return {
      localAddress: address.address || null,
      localPort: address.port || null,
    };
  } catch (_) {
    return {
      localAddress: null,
      localPort: null,
    };
  }
}

function serializeSocket(info) {
  return {
    id: info.id,
    role: info.role,
    label: info.label,
    status: info.status,
    localAddress: info.localAddress,
    localPort: info.localPort,
    peerAddress: info.peerAddress,
    peerPort: info.peerPort,
    bytesRead: info.bytesRead,
    bytesWritten: info.bytesWritten,
    packetsRead: info.packetsRead,
    packetsWritten: info.packetsWritten,
    openedAt: info.openedAt,
    closedAt: info.closedAt,
    lastError: info.lastError,
  };
}

function bindSocket(socket, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off("error", onError);
      resolve();
    };

    socket.once("error", onError);
    socket.bind(port, host, onListening);
  });
}

function sendDatagram(socket, payload, port, host) {
  return new Promise((resolve, reject) => {
    socket.send(payload, port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    socket.once("close", finish);

    try {
      socket.close();
    } catch (_) {
      finish();
    }
  });
}

class UdpLabManager {
  constructor() {
    ensureLogStore();

    this.host = DEFAULT_HOST;
    this.port = DEFAULT_PORT;
    this.logs = [];
    this.logSequence = 0;
    this.socketSequence = 0;
    this.stateVersion = 0;
    this.socketEntries = new Map();
    this.serverSocketId = null;
    this.streams = new Set();
  }

  emit(event) {
    const record = {
      id: makeId("udp-lab", ++this.logSequence),
      at: new Date().toISOString(),
      stateVersion: ++this.stateVersion,
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
      version: this.stateVersion,
      host: this.host,
      port: this.port,
      listening: Boolean(this.serverSocketId && this.socketEntries.get(this.serverSocketId)?.socket),
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
      id: makeId("udp-sock", ++this.socketSequence),
      role,
      label,
      status: "opening",
      localAddress: null,
      localPort: null,
      peerAddress: null,
      peerPort: null,
      bytesRead: 0,
      bytesWritten: 0,
      packetsRead: 0,
      packetsWritten: 0,
      openedAt: null,
      closedAt: null,
      lastError: null,
    };
  }

  syncSocketInfo(info, socket) {
    const local = localSocketAddress(socket);
    info.localAddress = local.localAddress;
    info.localPort = local.localPort;
  }

  attachSocket(socket, info) {
    const entry = {
      info,
      socket,
    };

    this.socketEntries.set(info.id, entry);
    this.syncSocketInfo(info, socket);

    socket.on("message", (buffer, rinfo) => {
      info.status = "open";
      info.bytesRead += buffer.length;
      info.packetsRead += 1;
      info.peerAddress = rinfo.address;
      info.peerPort = rinfo.port;
      this.syncSocketInfo(info, socket);

      this.emit({
        protocol: "UDP",
        category: "socket",
        action: "data",
        socketId: info.id,
        role: info.role,
        label: info.label,
        localAddress: info.localAddress,
        localPort: info.localPort,
        peerAddress: info.peerAddress,
        peerPort: info.peerPort,
        ...bufferFields(buffer),
        detail: `${info.label}가 ${buffer.length}B datagram을 수신했다.`,
      });
      this.pushState();
    });

    socket.on("close", () => {
      info.status = "closed";
      info.closedAt = new Date().toISOString();
      this.syncSocketInfo(info, socket);
      entry.socket = null;

      if (info.id === this.serverSocketId) {
        this.serverSocketId = null;
      }

      this.emit({
        protocol: "UDP",
        category: "socket",
        action: "close",
        socketId: info.id,
        role: info.role,
        label: info.label,
        localAddress: info.localAddress,
        localPort: info.localPort,
        peerAddress: info.peerAddress,
        peerPort: info.peerPort,
        detail: `${info.label} 닫힘이 확인됐다.`,
      });
      this.pushState();
    });

    socket.on("error", (error) => {
      info.status = "error";
      info.lastError = error.message;
      this.syncSocketInfo(info, socket);

      this.emit({
        protocol: "UDP",
        category: "socket",
        action: "error",
        socketId: info.id,
        role: info.role,
        label: info.label,
        code: error.code || null,
        message: error.message,
        localAddress: info.localAddress,
        localPort: info.localPort,
        peerAddress: info.peerAddress,
        peerPort: info.peerPort,
        detail: `${info.label}에서 오류가 발생했다.`,
      });
      this.pushState();
    });

    return entry;
  }

  async startServer(options = {}) {
    if (this.serverSocketId && this.socketEntries.get(this.serverSocketId)?.socket) {
      throw new Error("UDP 실험실 서버가 이미 실행 중이다.");
    }

    this.host = normalizeHost(options.host);
    this.port = normalizePort(options.port, this.port);

    const socket = dgram.createSocket("udp4");
    const info = this.createSocketInfo("server-socket", "서버 소켓");
    const entry = this.attachSocket(socket, info);

    await bindSocket(socket, this.port, this.host);

    info.status = "open";
    info.openedAt = new Date().toISOString();
    this.syncSocketInfo(info, socket);
    this.serverSocketId = info.id;

    this.emit({
      protocol: "UDP",
      category: "server",
      action: "listening",
      socketId: info.id,
      role: info.role,
      label: info.label,
      host: this.host,
      port: this.port,
      localAddress: info.localAddress,
      localPort: info.localPort,
      detail: `${this.host}:${this.port} 에서 UDP 서버 소켓 바인드를 시작했다.`,
    });
    this.pushState();

    return this.getState();
  }

  async stopServer() {
    const openEntries = Array.from(this.socketEntries.values()).filter(
      (entry) => entry.socket,
    );

    await Promise.all(openEntries.map((entry) => closeSocket(entry.socket)));

    this.serverSocketId = null;
    this.emit({
      protocol: "UDP",
      category: "server",
      action: "stopped",
      host: this.host,
      port: this.port,
      detail: `${this.host}:${this.port} UDP 실험실 소켓을 모두 정리했다.`,
    });
    this.pushState();

    return this.getState();
  }

  async bindManagedClient(options = {}) {
    const host = normalizeHost(options.host || this.host);
    const port = normalizeBindPort(options.port, 0);
    const label = typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "클라이언트";

    const socket = dgram.createSocket("udp4");
    const info = this.createSocketInfo("managed-client", label);
    this.attachSocket(socket, info);

    await bindSocket(socket, port, host);

    info.status = "open";
    info.openedAt = new Date().toISOString();
    this.syncSocketInfo(info, socket);

    this.emit({
      protocol: "UDP",
      category: "client",
      action: "bound",
      socketId: info.id,
      role: info.role,
      label: info.label,
      host,
      port: info.localPort,
      localAddress: info.localAddress,
      localPort: info.localPort,
      detail: `${info.label}가 ${info.localAddress}:${info.localPort} 에 바인드됐다.`,
    });
    this.pushState();

    return this.getState();
  }

  async send(socketId, text, target = {}) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket) {
      throw new Error("선택한 소켓은 전송 가능한 상태가 아니다.");
    }

    const payload = Buffer.from(typeof text === "string" ? text : String(text || ""), "utf8");
    if (payload.length === 0) {
      throw new Error("메시지는 비워 둘 수 없다.");
    }

    const host = normalizeHost(target.host || entry.info.peerAddress || this.host);
    const fallbackPort = entry.info.role === "managed-client" ? this.port : entry.info.peerPort;
    const port = resolveTargetPort(target.port, fallbackPort);

    await sendDatagram(entry.socket, payload, port, host);

    entry.info.status = "open";
    entry.info.bytesWritten += payload.length;
    entry.info.packetsWritten += 1;
    entry.info.peerAddress = host;
    entry.info.peerPort = port;
    this.syncSocketInfo(entry.info, entry.socket);

    this.emit({
      protocol: "UDP",
      category: "socket",
      action: "send",
      socketId: entry.info.id,
      role: entry.info.role,
      label: entry.info.label,
      localAddress: entry.info.localAddress,
      localPort: entry.info.localPort,
      peerAddress: entry.info.peerAddress,
      peerPort: entry.info.peerPort,
      ...bufferFields(payload),
      detail: `${entry.info.label}가 ${host}:${port} 로 ${payload.length}B datagram을 전송했다.`,
    });
    this.pushState();

    return this.getState();
  }

  async closeSocket(socketId) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket) {
      throw new Error("선택한 소켓이 열려 있지 않다.");
    }

    await closeSocket(entry.socket);
    return this.getState();
  }
}

function createUdpLabManager() {
  return new UdpLabManager();
}

module.exports = {
  DEFAULT_UDP_LAB_HOST: DEFAULT_HOST,
  DEFAULT_UDP_LAB_PORT: DEFAULT_PORT,
  UDP_LAB_LOG_FILE: LOG_FILE,
  createUdpLabManager,
};
