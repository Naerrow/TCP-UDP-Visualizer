const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { URL } = require("url");

const HOST = "127.0.0.1";
const WEB_PORT = Number(process.env.PORT) || 3000;
const TCP_PORT = Number(process.env.TCP_PORT) || 4100;

const publicDir = path.join(__dirname, "public");
const clients = new Set();
let tcpSession = null;

function sendEvent(event) {
  const payload = `data: ${JSON.stringify({
    ...event,
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    at: new Date().toISOString(),
  })}\n\n`;

  for (const client of clients) {
    client.write(payload);
  }
}

function respondJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const typeMap = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };

    res.writeHead(200, { "Content-Type": typeMap[ext] || "text/plain; charset=utf-8" });
    res.end(data);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeTcpServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

class TcpSession {
  constructor() {
    this.protocol = "TCP";
    this.session = `tcp-${Date.now()}`;
    this.stepIndex = 0;
    this.completed = false;
    this.payload = `TCP says hello at ${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`;
    this.server = null;
    this.serverSocket = null;
    this.clientSocket = null;
    this.pendingConnect = null;
    this.pendingData = null;
    this.pendingResponse = null;
    this.pendingDataReady = null;
    this.resolveDataReady = null;
    this.pendingAccepted = null;
    this.resolveAccepted = null;
    this.pendingClientEnd = null;
    this.resolveClientEnd = null;
    this.pendingServerClose = null;
    this.resolveServerClose = null;
  }

  async start() {
    this.pendingAccepted = new Promise((resolve) => {
      this.resolveAccepted = resolve;
    });
    this.pendingClientEnd = new Promise((resolve) => {
      this.resolveClientEnd = resolve;
    });
    this.pendingServerClose = new Promise((resolve) => {
      this.resolveServerClose = resolve;
    });

    this.server = net.createServer((socket) => {
      this.serverSocket = socket;
      if (this.resolveAccepted) {
        this.resolveAccepted();
        this.resolveAccepted = null;
      }

      socket.on("data", (buffer) => {
        const text = buffer.toString("utf8");
        this.pendingData = {
          bytes: buffer.length,
          message: text,
        };
        if (this.resolveDataReady) {
          this.resolveDataReady();
          this.resolveDataReady = null;
        }

        const responseMessage = `APP RESPONSE:${text.length}B`;
        socket.write(responseMessage);
      });

      socket.on("end", () => {
        if (this.resolveClientEnd) {
          this.resolveClientEnd();
          this.resolveClientEnd = null;
        }
      });

      socket.on("close", () => {
        if (this.resolveServerClose) {
          this.resolveServerClose();
          this.resolveServerClose = null;
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(TCP_PORT, HOST, resolve);
    });

    this.pendingDataReady = new Promise((resolve) => {
      this.resolveDataReady = resolve;
    });

    sendEvent({
      protocol: this.protocol,
      session: this.session,
      type: "state",
      side: "server",
      label: "BIND",
      detail: `Server binds ${HOST}:${TCP_PORT}. 이제 이 포트로 들어오는 TCP 연결 요청을 받을 수 있다.`,
      controls: {
        canAdvance: true,
        completed: false,
      },
    });

    sendEvent({
      protocol: this.protocol,
      session: this.session,
      type: "session",
      phase: "start",
      title: "TCP step demo started",
      detail: "이 데모는 앱에서 관찰 가능한 소켓 API 단계와, 그 뒤에서 TCP가 무엇을 하는지 연결해서 설명한다.",
      controls: {
        canAdvance: true,
        completed: false,
      },
    });

    sendEvent({
      protocol: this.protocol,
      session: this.session,
      type: "state",
      side: "server",
      label: "LISTEN + ACCEPT WAIT",
      detail: `Server is listening on ${HOST}:${TCP_PORT}. 서버 애플리케이션은 accept()에서 새 연결이 오기를 기다리는 상태다.`,
      controls: {
        canAdvance: true,
        completed: false,
      },
    });
  }

  async next() {
    if (this.completed) {
      return { completed: true };
    }

    switch (this.stepIndex) {
      case 0:
        this.stepIndex += 1;
        this.clientSocket = net.createConnection({ host: HOST, port: TCP_PORT });
        this.pendingConnect = new Promise((resolve, reject) => {
          this.clientSocket.once("error", reject);
          this.clientSocket.once("connect", resolve);
        });

        this.pendingResponse = new Promise((resolve, reject) => {
          this.clientSocket.once("error", reject);
          this.clientSocket.once("data", (buffer) => resolve(buffer.toString("utf8")));
        });

        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "syscall",
          label: "connect()",
          detail: "Client application calls connect(). 이 순간부터 커널 TCP 스택이 SYN, SYN-ACK, ACK를 교환해 연결을 성립시키려 한다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 1:
        this.stepIndex += 1;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "handshake",
          from: "client",
          to: "server",
          label: "SYN",
          detail: "클라이언트 커널이 연결 요청 세그먼트를 서버로 보낸다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 2:
        this.stepIndex += 1;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "handshake",
          from: "server",
          to: "client",
          label: "SYN-ACK",
          detail: "서버 커널이 연결 요청을 받고, 수락 의사와 함께 응답 세그먼트를 돌려보낸다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 3:
        this.stepIndex += 1;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "handshake",
          from: "client",
          to: "server",
          label: "ACK",
          detail: "클라이언트 커널이 마지막 확인 세그먼트를 보내며 3-way handshake를 마무리한다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 4:
        this.stepIndex += 1;
        await this.pendingConnect;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "syscall",
          label: "connect() returned",
          detail: "클라이언트 애플리케이션 관점에서 connect() 호출이 성공으로 끝났다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 5:
        this.stepIndex += 1;
        await this.pendingAccepted;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "accept",
          side: "server",
          label: "accept() returned",
          detail: "서버 애플리케이션은 accept()로 새 연결 소켓을 돌려받았다. listening socket은 계속 살아 있다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 6:
        this.stepIndex += 1;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "state",
          side: "both",
          label: "ESTABLISHED",
          detail: "이제 양쪽 애플리케이션은 연결된 TCP 소켓으로 데이터를 주고받을 수 있다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 7:
        this.stepIndex += 1;
        this.clientSocket.write(this.payload);
        await wait(80);
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "state",
          from: "client",
          to: "server",
          label: `SEQ ${Buffer.byteLength(this.payload)}B`,
          bytes: Buffer.byteLength(this.payload),
          message: this.payload,
          detail: "애플리케이션이 보낸 데이터는 TCP에 의해 세그먼트로 나뉘어 전달되지만, 앱 입장에서는 하나의 순서 있는 바이트 스트림처럼 보인다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 8:
        this.stepIndex += 1;
        if (!this.pendingData) {
          await this.pendingDataReady;
        }
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "state",
          side: "server",
          label: "DATA ARRIVED",
          detail: `Server application read from its socket buffer: "${this.pendingData ? this.pendingData.message : this.payload}"`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 9: {
        this.stepIndex += 1;
        const response = await this.pendingResponse;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "response",
          from: "server",
          to: "client",
          label: response,
          detail: "이 메시지는 서버 애플리케이션이 보낸 응답이다. TCP의 ACK와 재전송은 이 앱 데이터와 별개로 전송계층 내부에서 처리된다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 10:
        this.stepIndex += 1;
        this.clientSocket.end();
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "close",
          from: "client",
          to: "server",
          label: "close() / FIN",
          detail: "Client application closes its write side. 커널은 FIN을 보내며 half-close를 시작한다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 11:
        this.stepIndex += 1;
        await this.pendingClientEnd;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "close",
          from: "server",
          to: "client",
          label: "FIN RECEIVED / ACK IMPLIED",
          detail: "Server application observed EOF on the connected socket. 즉, peer의 FIN이 앱 수준에서 보이기 시작했다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 12:
        this.stepIndex += 1;
        if (this.serverSocket && !this.serverSocket.destroyed) {
          this.serverSocket.end();
        }
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "close",
          from: "server",
          to: "client",
          label: "server close() / FIN",
          detail: "Server application also closes its side. 커널은 반대 방향 FIN을 보내며 연결 종료를 마무리한다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 13:
        this.stepIndex += 1;
        await this.pendingServerClose;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "close",
          from: "client",
          to: "server",
          label: "FINAL ACK IMPLIED / CLOSED",
          detail: "양쪽 애플리케이션 관점에서 연결 종료가 관찰되었다. 마지막 ACK 자체는 사용자 공간 API에서 직접 보이지 않지만, close 완료로 종료를 확인할 수 있다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 14:
        this.stepIndex += 1;
        sendEvent({
          protocol: this.protocol,
          session: this.session,
          type: "session",
          phase: "complete",
          title: "TCP session completed",
          detail: "connect() 호출부터 SYN, SYN-ACK, ACK, connect() 반환, accept() 반환, ESTABLISHED, 데이터 송수신, 종료까지 확인했다.",
          controls: {
            canAdvance: false,
            completed: true,
          },
        });
        this.completed = true;
        await this.cleanup();
        return { completed: true };

      default:
        return { completed: true };
    }
  }

  async cleanup() {
    if (this.clientSocket && !this.clientSocket.destroyed) {
      this.clientSocket.destroy();
    }
    if (this.serverSocket && !this.serverSocket.destroyed) {
      this.serverSocket.destroy();
    }
    if (this.server) {
      await closeTcpServer(this.server);
      this.server = null;
    }
  }
}
async function cleanupSession() {
  if (tcpSession) {
    await tcpSession.cleanup();
    tcpSession = null;
  }
}

async function handleDemoStart(req, res) {
  try {
    await cleanupSession();
    tcpSession = new TcpSession();
    await tcpSession.start();
    respondJson(res, 202, { ok: true, protocol: "tcp", session: tcpSession.session });
  } catch (error) {
    respondJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleDemoNext(req, res) {
  try {
    if (!tcpSession) {
      respondJson(res, 409, { ok: false, error: "No active session. Start a demo first." });
      return;
    }

    const result = await tcpSession.next();
    if (result.completed) {
      tcpSession = null;
    }

    respondJson(res, 202, { ok: true, protocol: "tcp", completed: result.completed });
  } catch (error) {
    await cleanupSession();
    sendEvent({
      protocol: "TCP",
      type: "error",
      title: "TCP demo failed",
      detail: error.message,
      controls: {
        canAdvance: false,
        completed: true,
      },
    });
    respondJson(res, 500, { ok: false, error: error.message });
  }
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    res.write("retry: 1000\n\n");
    clients.add(res);

    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/demo/tcp/start") {
    handleDemoStart(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/demo/tcp/next") {
    handleDemoNext(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(WEB_PORT, HOST, () => {
  console.log(`Visualizer running at http://${HOST}:${WEB_PORT}`);
});
