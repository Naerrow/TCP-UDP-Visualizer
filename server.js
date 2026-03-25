const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const dgram = require("dgram");
const { URL } = require("url");
const { createTcpLabManager, TCP_LAB_LOG_FILE } = require("./tcp-lab");

const HOST = "127.0.0.1";
const WEB_PORT = Number(process.env.PORT) || 3000;
const TCP_PORT = Number(process.env.TCP_PORT) || 4100;
const UDP_PORT = Number(process.env.UDP_PORT) || 4300;

const publicDir = path.join(__dirname, "public");
let tcpSession = null;
let udpSession = null;
const tcpLab = createTcpLabManager();

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") {
      resolve({});
      return;
    }

    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function serveLabLogFile(res) {
  const stream = fs.createReadStream(TCP_LAB_LOG_FILE);
  stream.on("error", () => {
    if (!res.headersSent) {
      respondJson(res, 500, { ok: false, error: "Failed to read the TCP lab log file." });
    } else {
      res.destroy();
    }
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": 'attachment; filename="tcp-lab.ndjson"',
    "Cache-Control": "no-store",
  });

  stream.pipe(res);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeTcpServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function bindUdpSocket(socket, port, host) {
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

function sendUdpDatagram(socket, payload, port, host) {
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

function closeUdpSocket(socket) {
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

class TcpSession {
  constructor() {
    this.protocol = "TCP";
    this.session = `tcp-${Date.now()}`;
    this.stepIndex = 0;
    this.completed = false;
    this.server = null;
    this.serverSocket = null;
    this.clientSocket = null;
    this.pendingConnect = null;
    this.receivedChunks = [];
    this.clientWrites = [];
    this.pendingResponse = null;
    this.pendingDataReady = null;
    this.resolveDataReady = null;
    this.pendingAccepted = null;
    this.resolveAccepted = null;
    this.pendingClientEnd = null;
    this.resolveClientEnd = null;
    this.pendingServerClose = null;
    this.resolveServerClose = null;
    this.stepEvents = [];
  }

  emit(event) {
    const enriched = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
    };
    this.stepEvents.push(enriched);
    return enriched;
  }

  flushEvents() {
    const events = this.stepEvents;
    this.stepEvents = [];
    return events;
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
        this.receivedChunks.push({
          bytes: buffer.length,
          message: buffer.toString("utf8"),
        });
        if (this.resolveDataReady) {
          this.resolveDataReady();
          this.resolveDataReady = null;
        }
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

    this.emit({
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

    this.emit({
      protocol: this.protocol,
      session: this.session,
      type: "session",
      phase: "start",
      title: "TCP 단계형 데모 시작",
      detail: "이 데모는 앱에서 관찰 가능한 소켓 API 단계와, 그 뒤에서 TCP가 무엇을 하는지 연결해서 설명한다.",
      controls: {
        canAdvance: true,
        completed: false,
      },
    });

    this.emit({
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

        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.clientWrites = [
          "MSG1",
          "MSG2",
        ];

        this.clientSocket.write(this.clientWrites[0]);
        this.clientSocket.write(this.clientWrites[1]);
        await wait(80);
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "data",
          from: "client",
          to: "server",
          label: `write #1 / ${Buffer.byteLength(this.clientWrites[0])}B`,
          bytes: Buffer.byteLength(this.clientWrites[0]),
          message: this.clientWrites[0],
          detail: `첫 번째 write() payload: ${this.clientWrites[0]}`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "data",
          from: "client",
          to: "server",
          label: `write #2 / ${Buffer.byteLength(this.clientWrites[1])}B`,
          bytes: Buffer.byteLength(this.clientWrites[1]),
          message: this.clientWrites[1],
          detail: `두 번째 write() payload: ${this.clientWrites[1]}`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "state",
          side: "both",
          label: `APP WRITES x2 / ${this.clientWrites.length} records`,
          detail: "클라이언트 애플리케이션은 write()를 두 번 호출했다. 다음 단계에서 서버가 이 바이트들을 몇 번의 read 이벤트로 관찰했는지 확인할 수 있다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 8:
        this.stepIndex += 1;
        if (this.receivedChunks.length === 0) {
          await this.pendingDataReady;
        }
        await wait(120);

        const totalBytes = this.receivedChunks.reduce(
          (sum, chunk) => sum + chunk.bytes,
          0,
        );
        const chunkSummary = this.receivedChunks
          .map(
            (chunk, index) =>
              `read#${index + 1}=${chunk.message}`,
          )
          .join(" | ");

        this.receivedChunks.forEach((chunk, index) => {
          this.emit({
            protocol: this.protocol,
            session: this.session,
            type: "read",
            side: "server",
            label: `read #${index + 1} / ${chunk.bytes}B`,
            message: chunk.message,
            detail: `서버가 읽은 데이터 ${index + 1}: ${chunk.message}`,
            controls: {
              canAdvance: true,
              completed: false,
            },
          });
        });

        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "state",
          side: "server",
          label: `READ BUFFER / ${this.receivedChunks.length} chunk(s), ${totalBytes}B`,
          detail: `서버가 읽은 결과: ${chunkSummary}. 즉, write() 2번이 read() 1번으로 합쳐질 수 있다.`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 9: {
        this.stepIndex += 1;
        const responseMessage = `APP RESPONSE: received ${this.receivedChunks.length} chunk(s), ${this.receivedChunks.reduce((sum, chunk) => sum + chunk.bytes, 0)}B`;
        this.serverSocket.write(responseMessage);
        const response = await this.pendingResponse;
        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.emit({
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
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "session",
          phase: "complete",
          title: "TCP 세션 종료",
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

class UdpSession {
  constructor() {
    this.protocol = "UDP";
    this.session = `udp-${Date.now()}`;
    this.stepIndex = 0;
    this.completed = false;
    this.serverSocket = null;
    this.clientSocket = null;
    this.clientAddress = null;
    this.serverMessages = [];
    this.clientMessages = [];
    this.serverWaiters = [];
    this.clientWaiters = [];
    this.stepEvents = [];
  }

  emit(event) {
    const enriched = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
    };
    this.stepEvents.push(enriched);
    return enriched;
  }

  flushEvents() {
    const events = this.stepEvents;
    this.stepEvents = [];
    return events;
  }

  observeDatagram(target, buffer, rinfo) {
    const datagram = {
      bytes: buffer.length,
      message: buffer.toString("utf8"),
      address: rinfo.address,
      port: rinfo.port,
    };

    if (target === "server") {
      this.serverMessages.push(datagram);
      const waiter = this.serverWaiters.shift();
      if (waiter) {
        waiter(datagram);
      }
      return;
    }

    this.clientMessages.push(datagram);
    const waiter = this.clientWaiters.shift();
    if (waiter) {
      waiter(datagram);
    }
  }

  waitForDatagram(target, index) {
    const messages = target === "server" ? this.serverMessages : this.clientMessages;
    const waiters = target === "server" ? this.serverWaiters : this.clientWaiters;

    if (messages.length > index) {
      return Promise.resolve(messages[index]);
    }

    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  async start() {
    this.serverSocket = dgram.createSocket("udp4");
    this.serverSocket.on("message", (buffer, rinfo) => {
      this.observeDatagram("server", buffer, rinfo);
    });

    await bindUdpSocket(this.serverSocket, UDP_PORT, HOST);

    this.emit({
      protocol: this.protocol,
      session: this.session,
      type: "state",
      side: "server",
      label: "BIND",
      detail: `UDP 서버 소켓이 ${HOST}:${UDP_PORT} 에 바인드됐다. 이제 이 포트로 들어오는 datagram을 받을 수 있다.`,
      controls: {
        canAdvance: true,
        completed: false,
      },
    });

    this.emit({
      protocol: this.protocol,
      session: this.session,
      type: "session",
      phase: "start",
      title: "UDP 단계형 데모 시작",
      detail: "이 데모는 UDP 소켓이 connect/accept 없이 datagram을 보내고 받는 과정을 단계별로 설명한다.",
      controls: {
        canAdvance: true,
        completed: false,
      },
    });

    this.emit({
      protocol: this.protocol,
      session: this.session,
      type: "state",
      side: "server",
      label: "RECVFROM WAIT",
      detail: "서버 애플리케이션은 recvfrom()에 해당하는 대기 상태로 첫 datagram을 기다린다.",
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
      case 0: {
        this.stepIndex += 1;
        this.clientSocket = dgram.createSocket("udp4");
        this.clientSocket.on("message", (buffer, rinfo) => {
          this.observeDatagram("client", buffer, rinfo);
        });

        await bindUdpSocket(this.clientSocket, 0, HOST);
        this.clientAddress = this.clientSocket.address();

        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "syscall",
          side: "client",
          label: "socket() + bind()",
          detail: `클라이언트 UDP 소켓을 만들고 ${this.clientAddress.address}:${this.clientAddress.port} 에 바인드했다. 이제 바로 datagram을 보낼 수 있다.`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 1:
        this.stepIndex += 1;
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "state",
          side: "both",
          label: "NO HANDSHAKE / NO ACCEPT",
          detail: "UDP는 SYN, SYN-ACK, ACK를 교환하지 않는다. 서버도 accept() 없이 datagram을 바로 recvfrom()으로 받는다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 2: {
        this.stepIndex += 1;
        const message = "MSG1";
        await sendUdpDatagram(this.clientSocket, message, UDP_PORT, HOST);
        await wait(40);
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "data",
          from: "client",
          to: "server",
          label: `send() #1 / ${Buffer.byteLength(message)}B`,
          bytes: Buffer.byteLength(message),
          message,
          detail: `클라이언트가 첫 번째 UDP datagram ${message} 를 ${HOST}:${UDP_PORT} 로 전송했다.`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 3: {
        this.stepIndex += 1;
        const datagram = await this.waitForDatagram("server", 0);
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "read",
          side: "server",
          label: `recvfrom() #1 / ${datagram.bytes}B`,
          message: datagram.message,
          detail: `서버가 ${datagram.address}:${datagram.port} 로부터 첫 datagram을 받았다: ${datagram.message}`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 4: {
        this.stepIndex += 1;
        const message = "MSG2";
        await sendUdpDatagram(this.clientSocket, message, UDP_PORT, HOST);
        await wait(40);
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "data",
          from: "client",
          to: "server",
          label: `send() #2 / ${Buffer.byteLength(message)}B`,
          bytes: Buffer.byteLength(message),
          message,
          detail: `클라이언트가 두 번째 UDP datagram ${message} 를 ${HOST}:${UDP_PORT} 로 전송했다.`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 5: {
        this.stepIndex += 1;
        const datagram = await this.waitForDatagram("server", 1);
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "read",
          side: "server",
          label: `recvfrom() #2 / ${datagram.bytes}B`,
          message: datagram.message,
          detail: `서버가 ${datagram.address}:${datagram.port} 로부터 두 번째 datagram을 받았다: ${datagram.message}`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 6:
        this.stepIndex += 1;
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "state",
          side: "both",
          label: "DATAGRAM BOUNDARIES PRESERVED",
          detail: "이번 실행에서는 send() 두 번이 recvfrom() 두 번으로 관찰됐다. UDP는 바이트 스트림이 아니라 datagram 경계를 유지한다. 다만 전달 보장과 순서 보장은 하지 않는다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 7: {
        this.stepIndex += 1;
        const target = this.serverMessages[0];
        const responseMessage = `UDP RESPONSE: ${this.serverMessages.length} datagrams`;
        await sendUdpDatagram(this.serverSocket, responseMessage, target.port, target.address);
        await wait(40);
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "response",
          from: "server",
          to: "client",
          label: `send() reply / ${Buffer.byteLength(responseMessage)}B`,
          message: responseMessage,
          detail: `서버가 ${target.address}:${target.port} 로 응답 datagram을 보냈다.`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 8: {
        this.stepIndex += 1;
        const datagram = await this.waitForDatagram("client", 0);
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "read",
          side: "client",
          label: `recvfrom() reply / ${datagram.bytes}B`,
          message: datagram.message,
          detail: `클라이언트가 서버 응답 datagram을 받았다: ${datagram.message}`,
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };
      }

      case 9:
        this.stepIndex += 1;
        await this.cleanup();
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "close",
          side: "both",
          label: "close() / NO FIN",
          detail: "UDP에는 연결 종료 handshake가 없다. 양쪽 소켓을 닫으면 커널의 UDP 엔드포인트만 정리되고 데모가 끝난다.",
          controls: {
            canAdvance: true,
            completed: false,
          },
        });
        return { completed: false };

      case 10:
        this.stepIndex += 1;
        this.emit({
          protocol: this.protocol,
          session: this.session,
          type: "session",
          phase: "complete",
          title: "UDP 세션 종료",
          detail: "bind, recvfrom wait, datagram 전송 2회, recvfrom 2회, reply, close까지 확인했다.",
          controls: {
            canAdvance: false,
            completed: true,
          },
        });
        this.completed = true;
        return { completed: true };

      default:
        return { completed: true };
    }
  }

  async cleanup() {
    if (this.clientSocket) {
      await closeUdpSocket(this.clientSocket);
      this.clientSocket = null;
    }
    if (this.serverSocket) {
      await closeUdpSocket(this.serverSocket);
      this.serverSocket = null;
    }
  }
}
async function cleanupTcpSession() {
  if (tcpSession) {
    await tcpSession.cleanup();
    tcpSession = null;
  }
}

async function cleanupUdpSession() {
  if (udpSession) {
    await udpSession.cleanup();
    udpSession = null;
  }
}

async function handleDemoStart(req, res) {
  try {
    await cleanupTcpSession();
    tcpSession = new TcpSession();
    await tcpSession.start();
    respondJson(res, 202, {
      ok: true,
      protocol: "tcp",
      session: tcpSession.session,
      completed: false,
      events: tcpSession.flushEvents(),
    });
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

    const session = tcpSession;
    const result = await session.next();
    const events = session.flushEvents();
    if (result.completed) {
      tcpSession = null;
    }

    respondJson(res, 202, {
      ok: true,
      protocol: "tcp",
      completed: result.completed,
      events,
    });
  } catch (error) {
    await cleanupTcpSession();
    const event = {
      protocol: "TCP",
      type: "error",
      title: "TCP 데모 실행 실패",
      detail: error.message,
      controls: {
        canAdvance: false,
        completed: true,
      },
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
    };
    respondJson(res, 500, { ok: false, error: error.message, events: [event] });
  }
}

async function handleUdpDemoStart(req, res) {
  try {
    await cleanupUdpSession();
    udpSession = new UdpSession();
    await udpSession.start();
    respondJson(res, 202, {
      ok: true,
      protocol: "udp",
      session: udpSession.session,
      completed: false,
      events: udpSession.flushEvents(),
    });
  } catch (error) {
    respondJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleUdpDemoNext(req, res) {
  try {
    if (!udpSession) {
      respondJson(res, 409, { ok: false, error: "No active session. Start a demo first." });
      return;
    }

    const session = udpSession;
    const result = await session.next();
    const events = session.flushEvents();
    if (result.completed) {
      udpSession = null;
    }

    respondJson(res, 202, {
      ok: true,
      protocol: "udp",
      completed: result.completed,
      events,
    });
  } catch (error) {
    await cleanupUdpSession();
    const event = {
      protocol: "UDP",
      type: "error",
      title: "UDP 데모 실행 실패",
      detail: error.message,
      controls: {
        canAdvance: false,
        completed: true,
      },
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
    };
    respondJson(res, 500, { ok: false, error: error.message, events: [event] });
  }
}

function respondLabState(res, status = 200) {
  respondJson(res, status, {
    ok: true,
    ...tcpLab.getState(),
  });
}

async function handleLabServerStart(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.startServer(body);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleLabServerStop(req, res) {
  try {
    await tcpLab.stopServer();
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleLabClientConnect(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.connectManagedClient(body);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleLabSocketSend(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.send(body.socketId, body.text);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleLabSocketEnd(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.end(body.socketId);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleLabSocketDestroy(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.destroy(body.socketId);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/demo/tcp/start") {
    handleDemoStart(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/demo/tcp/next") {
    handleDemoNext(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/demo/udp/start") {
    handleUdpDemoStart(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/demo/udp/next") {
    handleUdpDemoNext(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/lab/tcp/state") {
    respondLabState(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/lab/tcp/stream") {
    tcpLab.registerStream(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/lab/tcp/logs/download") {
    serveLabLogFile(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/lab/tcp/server/start") {
    handleLabServerStart(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/lab/tcp/server/stop") {
    handleLabServerStop(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/lab/tcp/client/connect") {
    handleLabClientConnect(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/lab/tcp/socket/send") {
    handleLabSocketSend(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/lab/tcp/socket/end") {
    handleLabSocketEnd(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/lab/tcp/socket/destroy") {
    handleLabSocketDestroy(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(WEB_PORT, HOST, () => {
  console.log(`Visualizer running at http://${HOST}:${WEB_PORT}`);
});
