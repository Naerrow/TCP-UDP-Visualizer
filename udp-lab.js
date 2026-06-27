const fs = require("fs");
const path = require("path");
const dgram = require("dgram");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.UDP_LAB_PORT) || 4301;
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "udp-lab.ndjson");
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

// UDP 포트 번호를 검증하고, 값이 없으면 기본 포트를 사용한다.
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

// 클라이언트 바인드용 포트를 검증하며, 0도 허용한다.
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

// 전송 대상 포트를 정한다. 직접 지정값이 없으면 상황에 맞는 기본값을 쓴다.
function resolveTargetPort(value, fallback) {
  if (value === undefined || value === null || value === "") {
    if (fallback) {
      return fallback;
    }
    throw new Error("대상 포트를 입력해야 한다.");
  }

  return normalizePort(value);
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

// UDP 소켓의 현재 로컬 주소와 포트를 읽어 온다.
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

// 내부에서 바뀌는 소켓 정보를 안전한 상태 정보로 바꾼다.
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

// UDP 소켓을 지정한 호스트와 포트에 바인드하고 완료를 기다린다.
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

// UDP 데이터그램 하나를 전송하고 완료를 기다린다.
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

// UDP 소켓을 닫고 종료 이벤트가 끝날 때까지 기다린다.
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

  // 실험실 이벤트 하나를 메모리, 디스크, 서버 전송 이벤트에 함께 기록한다.
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

  // 현재 실험실을 보고 있는 모든 브라우저에 서버 전송 이벤트 내용을 보낸다.
  broadcast(payload) {
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;

    for (const res of this.streams) {
      res.write(chunk);
    }
  }

  // 소켓이나 서버 상태가 바뀐 뒤 최신 전체 상태를 방송한다.
  pushState() {
    this.broadcast({ type: "state", state: this.getState() });
  }

  // 현재 실험실 상태 정보를 반환한다. 서버 바인드 상태, 소켓 목록, 최근 로그가 들어 있다.
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

  // 실험실에서 UDP 소켓 하나를 추적할 때 쓰는 메타데이터 객체를 만든다.
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

  // 실제 소켓의 최신 로컬 주소 정보를 메타데이터에 반영한다.
  syncSocketInfo(info, socket) {
    const local = localSocketAddress(socket);
    info.localAddress = local.localAddress;
    info.localPort = local.localPort;
  }

  // 소켓 하나에 리스너를 붙여 수신, 종료, 오류를 모두 로그와 상태에 반영하게 한다.
  attachSocket(socket, info) {
    const entry = {
      info,
      socket,
    };

    this.socketEntries.set(info.id, entry);
    this.syncSocketInfo(info, socket);

    // 데이터그램 하나를 받으면 바이트 수, 패킷 수, 최근 상대 주소를 갱신한다.
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

    // 소켓이 닫히면 닫힘 시각과 상태를 기록한다.
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

    // 오류가 나면 오류 상태와 메시지를 기록한다.
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

  // 실험실 페이지에서 사용하는 실제 UDP 서버 소켓을 시작한다.
  async startServer(options = {}) {
    if (this.serverSocketId && this.socketEntries.get(this.serverSocketId)?.socket) {
      throw new Error("UDP 실험실 서버가 이미 실행 중이다.");
    }

    this.host = normalizeHost(options.host);
    this.port = normalizePort(options.port, this.port);

    // 서버 소켓을 만들고 추적 대상에 등록한다.
    const socket = dgram.createSocket("udp4");
    const info = this.createSocketInfo("server-socket", "서버 소켓");
    this.attachSocket(socket, info);

    // 지정한 포트에 실제로 바인드될 때까지 기다린다.
    await bindSocket(socket, this.port, this.host);

    // 바인드가 끝나면 열림 상태와 시작 시각을 기록한다.
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

  // 열려 있는 UDP 소켓들을 모두 닫고 서버 상태를 정리한다.
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

  // 관리형 UDP 클라이언트 소켓을 만들고 지정한 호스트와 포트에 바인드한다.
  async bindManagedClient(options = {}) {
    const host = normalizeHost(options.host || this.host);
    const port = normalizeBindPort(options.port, 0);
    const label = typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "클라이언트";

    // 클라이언트 소켓을 만들고 추적 대상에 등록한다.
    const socket = dgram.createSocket("udp4");
    const info = this.createSocketInfo("managed-client", label);
    this.attachSocket(socket, info);

    // 0 포트가 들어오면 운영체제가 비어 있는 임시 포트를 골라 준다.
    await bindSocket(socket, port, host);

    // 바인드가 끝난 뒤 열린 소켓 상태로 표시한다.
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

  // 선택한 UDP 소켓 하나에서 데이터그램을 전송한다.
  async send(socketId, text, target = {}) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket) {
      throw new Error("선택한 소켓은 전송 가능한 상태가 아니다.");
    }

    // 문자열 입력을 실제 전송할 바이트 버퍼로 바꾼다.
    const payload = Buffer.from(typeof text === "string" ? text : String(text || ""), "utf8");
    if (payload.length === 0) {
      throw new Error("메시지는 비워 둘 수 없다.");
    }

    // 대상 주소와 포트를 정한다. 값이 없으면 최근 상대나 기본 서버 포트를 사용한다.
    const host = normalizeHost(target.host || entry.info.peerAddress || this.host);
    const fallbackPort = entry.info.role === "managed-client" ? this.port : entry.info.peerPort;
    const port = resolveTargetPort(target.port, fallbackPort);

    // 실제 데이터그램 전송이 끝날 때까지 기다린다.
    await sendDatagram(entry.socket, payload, port, host);

    // 전송 후에는 최근 상대, 바이트 수, 패킷 수를 갱신한다.
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

  // 선택한 UDP 소켓 하나를 닫고 최신 상태를 반환한다.
  async closeSocket(socketId) {
    const entry = this.socketEntries.get(socketId);
    if (!entry || !entry.socket) {
      throw new Error("선택한 소켓이 열려 있지 않다.");
    }

    await closeSocket(entry.socket);
    return this.getState();
  }
}

// 서버 시작 시점에 UDP 실험실 매니저를 한 번 생성할 때 쓰는 생성 함수다.
function createUdpLabManager() {
  return new UdpLabManager();
}

module.exports = {
  DEFAULT_UDP_LAB_HOST: DEFAULT_HOST,
  DEFAULT_UDP_LAB_PORT: DEFAULT_PORT,
  UDP_LAB_LOG_FILE: LOG_FILE,
  createUdpLabManager,
};
