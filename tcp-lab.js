const fs = require("fs");
const path = require("path");
const net = require("net");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.TCP_LAB_PORT) || 4200;
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "tcp-lab.ndjson");
const MAX_MEMORY_LOGS = 300;

// 실험실이 시작되기 전에 로그 디렉터리와 줄 단위 제이슨 로그 파일이 있는지 보장한다.
function ensureLogStore() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "");
  }
}

// 호스트 값을 정리하고, 비어 있으면 로컬 호스트로 대체한다.
function normalizeHost(value) {
  if (typeof value !== "string") {
    return DEFAULT_HOST;
  }

  const trimmed = value.trim();
  return trimmed || DEFAULT_HOST;
}

// TCP 포트 번호를 검증하고, 값이 없으면 기본 포트를 사용한다.
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

// 로그와 소켓에 쓸 읽기 쉬운 식별자를 만든다.
function makeId(prefix, sequence) {
  return `${prefix}-${Date.now()}-${sequence}`;
}

// 버퍼를 로그에 보여 주기 쉬운 값들로 변환한다.
function bufferFields(buffer) {
  const utf8 = buffer.toString("utf8");
  return {
    bytes: buffer.length,
    utf8,
    hex: buffer.toString("hex"),
  };
}

// TCP 소켓에서 로컬과 원격 주소 정보를 읽어 온다.
function socketAddresses(socket) {
  return {
    localAddress: socket.localAddress || null,
    localPort: socket.localPort || null,
    remoteAddress: socket.remoteAddress || null,
    remotePort: socket.remotePort || null,
  };
}

// 내부에서 바뀌는 소켓 정보를 안전한 상태 정보로 바꾼다.
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
    this.stateVersion = 0;
    this.socketEntries = new Map();
    this.streams = new Set();
  }

  // 실험실 이벤트 하나를 메모리, 디스크, 서버 전송 이벤트에 함께 기록한다.
  emit(event) {
    const record = {
      id: makeId("lab", ++this.logSequence),
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

  // 현재 실험실을 보고 있는 모든 브라우저에 서버 전송 이벤트 내용을 보낸다.
  broadcast(payload) {
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;

    for (const res of this.streams) {
      res.write(chunk);
    }
  }

  // 소켓이나 서버 상태가 바뀐 뒤 최신 전체 상태 스냅샷을 방송한다.
  pushState() {
    this.broadcast({ type: "state", state: this.getState() });
  }

  // 현재 실험실 상태 정보를 반환한다. 리스너 정보, 소켓 목록, 최근 로그가 들어 있다.
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
      listening: Boolean(this.server),
      serverStartedAt: this.serverStartedAt,
      logFile: LOG_FILE,
      sockets,
      logs: this.logs,
    };
  }

  // 브라우저가 실험실 변화를 실시간으로 받을 수 있도록 서버 전송 이벤트 스트림을 연다.
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

  // 실험실에서 TCP 소켓 하나를 추적할 때 쓰는 메타데이터 객체를 만든다.
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

  // 실제 소켓의 최신 상태를 메타데이터 객체에 반영한다.
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

  // 소켓 하나에 리스너를 붙여 카운터, 상태, 로그, 화면 상태를 함께 갱신하게 한다.
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
        detail: `${info.label}가 ${buffer.length}B를 수신했다.`,
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
        detail: `${info.label}가 상대의 FIN을 관찰했다.`,
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
        detail: `${info.label} 소켓이 닫혔다.`,
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
        detail: `${info.label}에서 오류가 발생했다.`,
      });
      this.pushState();
    });

    return entry;
  }

  // 실험실 페이지에서 사용하는 실제 TCP 리스너를 시작한다.
  async startServer(options = {}) {
    if (this.server) {
      throw new Error("TCP 실험실 서버가 이미 실행 중이다.");
    }

    this.host = normalizeHost(options.host);
    this.port = normalizePort(options.port, this.port);

    const server = net.createServer((socket) => {
      const info = this.createSocketInfo("server-peer", "서버 소켓");
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
        detail: `${socket.remoteAddress}:${socket.remotePort} 에서 들어온 TCP 연결을 서버가 수락했다.`,
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
        detail: "TCP 실험실 서버에서 오류가 발생했다.",
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
      detail: `${this.host}:${this.port} 에서 TCP 리스닝을 시작했다.`,
    });
    this.pushState();

    return this.getState();
  }

  // 리스너를 멈추고 아직 열려 있는 소켓도 가능하면 정상 종료를 시도한다.
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
      detail: `${this.host}:${this.port} TCP 리스닝을 중지했다.`,
    });
    this.pushState();

    return this.getState();
  }

  // 관리형 클라이언트 소켓을 만들고 선택한 TCP 리스너에 연결한다.
  async connectManagedClient(options = {}) {
    const host = normalizeHost(options.host || this.host);
    const port = normalizePort(options.port, this.port);
    const label = typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "클라이언트";

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
      detail: `${info.label}가 ${host}:${port} 연결을 시도했다.`,
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
          detail: `${info.label}가 ${host}:${port}에 연결됐다.`,
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

  // 선택한 소켓 하나에 유티에프에잇 애플리케이션 데이터를 쓰고 그 기록을 남긴다.
  async send(socketId, text) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket || entry.socket.destroyed) {
      throw new Error("선택한 소켓은 전송 가능한 상태가 아니다.");
    }

    const payload = Buffer.from(typeof text === "string" ? text : String(text || ""), "utf8");
    if (payload.length === 0) {
      throw new Error("메시지는 비워 둘 수 없다.");
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
      detail: `${entry.info.label}가 ${payload.length}B를 전송했다.`,
    });
    this.pushState();

    return this.getState();
  }

  // 선택한 소켓 하나에 정상 종료 메서드를 호출해 TCP 종료를 시작한다.
  async end(socketId) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket || entry.socket.destroyed) {
      throw new Error("선택한 소켓이 열려 있지 않다.");
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
      detail: `${entry.info.label}가 socket.end()로 FIN 전송을 시작했다.`,
    });
    this.pushState();

    return this.getState();
  }

  // 정상 종료를 기다리지 않고 선택한 소켓 하나를 즉시 파괴한다.
  async destroy(socketId) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket || entry.socket.destroyed) {
      throw new Error("선택한 소켓이 열려 있지 않다.");
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
      detail: `${entry.info.label}가 소켓을 강제로 종료했다.`,
    });
    this.pushState();

    return this.getState();
  }

  // 아직 조작 가능한 상태로 열려 있는 소켓만 골라 반환한다.
  openSocketOptions() {
    return Array.from(this.socketEntries.values())
      .filter((entry) => entry.socket && !entry.socket.destroyed)
      .map((entry) => serializeSocket(entry.info));
  }
}

// 이 서버 파일에서 시작 시점에 실험실 매니저를 한 번 생성할 때 쓰는 생성 함수다.
function createTcpLabManager() {
  return new TcpLabManager();
}

module.exports = {
  DEFAULT_TCP_LAB_HOST: DEFAULT_HOST,
  DEFAULT_TCP_LAB_PORT: DEFAULT_PORT,
  TCP_LAB_LOG_FILE: LOG_FILE,
  createTcpLabManager,
};
