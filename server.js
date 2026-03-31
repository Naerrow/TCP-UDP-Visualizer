const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const dgram = require("dgram");
const { URL } = require("url");
const { createTcpLabManager, TCP_LAB_LOG_FILE } = require("./tcp-lab");
const { createUdpLabManager, UDP_LAB_LOG_FILE } = require("./udp-lab");

const HOST = "127.0.0.1";
const WEB_PORT = Number(process.env.PORT) || 3000;
const TCP_PORT = Number(process.env.TCP_PORT) || 4100;
const UDP_PORT = Number(process.env.UDP_PORT) || 4300;

const publicDir = path.join(__dirname, "public");
let tcpSession = null;
let udpSession = null;
const tcpLab = createTcpLabManager();
const udpLab = createUdpLabManager();

// 데모 요청과 실제 실험실 요청에서 공통으로 쓰는 제이슨 응답 함수다.
function respondJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

// 정적 파일 폴더 아래의 파일을 제공하고, 그 바깥 경로 접근은 막는다.
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

// 요청 본문을 제이슨으로 읽고 해석하며, 너무 큰 본문은 차단한다.
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

// 저장된 실험 로그 파일을 줄 단위 제이슨 내려받기 형태로 브라우저에 전송한다.
function serveLabLogFile(res, filePath, downloadName, readErrorMessage) {
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      respondJson(res, 500, { ok: false, error: readErrorMessage });
    } else {
      res.destroy();
    }
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "Cache-Control": "no-store",
  });

  stream.pipe(res);
}

// 단계형 데모가 너무 빠르게 지나가지 않도록 잠깐 기다릴 때 쓰는 함수다.
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 리스너 종료 메서드를 프로미스로 감싸서 종료 완료를 기다릴 수 있게 한다.
function closeTcpServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// 유디피 단계형 데모에서 공통으로 쓰는 바인드 보조 함수다.
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

// 유디피 단계형 데모에서 공통으로 쓰는 전송 보조 함수다.
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

// 유디피 단계형 데모에서 공통으로 쓰는 종료 보조 함수다.
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

  // 타임라인 이벤트 하나를 버퍼에 넣어 두었다가 시작 또는 다음 단계 응답 때 한꺼번에 보낸다.
  emit(event) {
    const enriched = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
    };
    this.stepEvents.push(enriched);
    return enriched;
  }

  // 지금까지 쌓인 이벤트 묶음을 반환하고 내부 버퍼를 비운다.
  flushEvents() {
    const events = this.stepEvents;
    this.stepEvents = [];
    return events;
  }

  // 실제 티시피 서버와 이후 단계에서 기다릴 프로미스들을 미리 준비한다.
  async start() {
    // 나중에 서버 쪽에서 새 연결을 실제로 수락했는지 기다리기 위한 프로미스다.
    this.pendingAccepted = new Promise((resolve) => {
      this.resolveAccepted = resolve;
    });
    // 나중에 서버가 클라이언트의 종료 신호를 받았는지 기다리기 위한 프로미스다.
    this.pendingClientEnd = new Promise((resolve) => {
      this.resolveClientEnd = resolve;
    });
    // 나중에 서버 소켓이 완전히 닫혔는지 기다리기 위한 프로미스다.
    this.pendingServerClose = new Promise((resolve) => {
      this.resolveServerClose = resolve;
    });

    // 데모에 사용할 실제 티시피 서버를 만든다.
    this.server = net.createServer((socket) => {
      // 서버가 이번 연결 전용 소켓을 하나 받으면 따로 저장해 둔다.
      this.serverSocket = socket;

      // 새 연결이 들어왔음을 대기 중인 쪽에 알려 준다.
      if (this.resolveAccepted) {
        this.resolveAccepted();
        this.resolveAccepted = null;
      }

      // 서버가 데이터를 받으면 바이트 수와 문자열 내용을 기록해 둔다.
      socket.on("data", (buffer) => {
        this.receivedChunks.push({
          bytes: buffer.length,
          message: buffer.toString("utf8"),
        });

        // 첫 데이터 도착을 기다리던 단계가 있으면 여기서 깨운다.
        if (this.resolveDataReady) {
          this.resolveDataReady();
          this.resolveDataReady = null;
        }
      });

      // 클라이언트가 정상 종료를 시작해 더 읽을 데이터가 없음을 알릴 때 실행된다.
      socket.on("end", () => {
        if (this.resolveClientEnd) {
          this.resolveClientEnd();
          this.resolveClientEnd = null;
        }
      });

      // 서버 소켓이 완전히 닫히면 종료 대기 중인 단계에 알려 준다.
      socket.on("close", () => {
        if (this.resolveServerClose) {
          this.resolveServerClose();
          this.resolveServerClose = null;
        }
      });
    });

    // 지정한 호스트와 포트에서 실제로 리스닝이 시작될 때까지 기다린다.
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(TCP_PORT, HOST, resolve);
    });

    // 나중에 서버 쪽 첫 데이터 수신을 기다릴 때 사용할 프로미스다.
    this.pendingDataReady = new Promise((resolve) => {
      this.resolveDataReady = resolve;
    });

    // 첫 번째 상태 이벤트: 서버가 포트에 바인드되었음을 화면에 알린다.
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

    // 두 번째 이벤트: 지금부터 TCP 단계형 데모가 시작되었음을 알린다.
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

    // 세 번째 상태 이벤트: 서버가 리스닝 중이며 새 연결을 기다리는 중임을 알린다.
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

  // 티시피 학습용 흐름을 한 단계씩 진행한다.
  async next() {
    if (this.completed) {
      return { completed: true };
    }

    // 각 분기는 화면에 보이는 티시피 타임라인의 한 단계에 대응한다.
    switch (this.stepIndex) {
      case 0:
        this.stepIndex += 1;
        // 실제 클라이언트 연결은 지금 시작하고, 설명은 여러 단계에 나눠 보여 준다.
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
        // 운영체제가 클라이언트 연결 성립을 알려 줄 때까지 기다린다.
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
        // 서버 애플리케이션이 수락된 소켓을 실제로 받을 때까지 기다린다.
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

        // 티시피가 메시지 큐가 아니라 바이트 흐름임을 보여 주려고 연속 전송을 수행한다.
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
        // 서버 쪽 수신 이벤트를 기다린 뒤, 실제로 어떻게 읽혔는지 요약한다.
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
        // 클라이언트 쪽에서 정상 종료 절차를 시작한다.
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
        // 서버가 클라이언트의 종료 신호를 본 뒤 서버 쪽도 종료를 시작한다.
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

  // 현재 티시피 데모 세션에서 사용한 소켓과 리스너를 모두 정리한다.
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

  // 타임라인 이벤트 하나를 버퍼에 넣어 두었다가 시작 또는 다음 단계 응답 때 한꺼번에 보낸다.
  emit(event) {
    const enriched = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
    };
    this.stepEvents.push(enriched);
    return enriched;
  }

  // 지금까지 쌓인 이벤트 묶음을 반환하고 내부 버퍼를 비운다.
  flushEvents() {
    const events = this.stepEvents;
    this.stepEvents = [];
    return events;
  }

  // 수신한 데이터그램 하나를 저장하고, 그쪽 대기자를 깨운다.
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

  // 지정한 쪽의 해당 순번 데이터그램을 반환하고, 아직 없으면 도착할 때까지 기다린다.
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

  // 유디피 학습용 데모에 쓰일 서버 쪽 소켓을 준비한다.
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

  // 유디피 학습용 흐름을 한 단계씩 진행한다.
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

  // 유디피 데모 세션에서 만든 양쪽 소켓을 모두 정리한다.
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

// 새 티시피 데모를 시작하기 전에 이전 세션이 남아 있으면 정리한다.
async function cleanupTcpSession() {
  if (tcpSession) {
    await tcpSession.cleanup();
    tcpSession = null;
  }
}

// 새 유디피 데모를 시작하기 전에 이전 세션이 남아 있으면 정리한다.
async function cleanupUdpSession() {
  if (udpSession) {
    await udpSession.cleanup();
    udpSession = null;
  }
}

// 새 티시피 학습용 데모를 시작하고 초기 타임라인 이벤트를 반환한다.
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

// 티시피 학습용 데모를 다음 단계로 진행한다.
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

// 새 유디피 학습용 데모를 시작하고 초기 타임라인 이벤트를 반환한다.
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

// 유디피 학습용 데모를 다음 단계로 진행한다.
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

// 실제 티시피 실험실의 최신 상태 정보를 반환한다.
function respondLabState(res, status = 200) {
  respondJson(res, status, {
    ok: true,
    ...tcpLab.getState(),
  });
}

// 실제 유디피 실험실의 최신 상태 정보를 반환한다.
function respondUdpLabState(res, status = 200) {
  respondJson(res, status, {
    ok: true,
    ...udpLab.getState(),
  });
}

// 실험실 페이지에서 쓸 실제 티시피 리스너를 연다.
async function handleLabServerStart(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.startServer(body);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 실제 티시피 리스너를 중지하고 활성 소켓도 함께 정리한다.
async function handleLabServerStop(req, res) {
  try {
    await tcpLab.stopServer();
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 500, { ok: false, error: error.message });
  }
}

// 서버 프로세스 안에서 관리형 실제 티시피 클라이언트 소켓을 만든다.
async function handleLabClientConnect(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.connectManagedClient(body);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 선택한 실제 티시피 소켓 하나로 애플리케이션 데이터를 보낸다.
async function handleLabSocketSend(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.send(body.socketId, body.text);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 선택한 소켓 하나에 대해 정상적인 티시피 종료를 시작한다.
async function handleLabSocketEnd(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.end(body.socketId);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 선택한 티시피 소켓 하나를 강제로 끊는다.
async function handleLabSocketDestroy(req, res) {
  try {
    const body = await readJsonBody(req);
    await tcpLab.destroy(body.socketId);
    respondLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 실험실 페이지에서 쓸 실제 유디피 서버 소켓을 연다.
async function handleUdpLabServerStart(req, res) {
  try {
    const body = await readJsonBody(req);
    await udpLab.startServer(body);
    respondUdpLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 실제 유디피 서버 소켓을 중지하고 활성 유디피 소켓도 함께 정리한다.
async function handleUdpLabServerStop(req, res) {
  try {
    await udpLab.stopServer();
    respondUdpLabState(res, 202);
  } catch (error) {
    respondJson(res, 500, { ok: false, error: error.message });
  }
}

// 서버 프로세스 안에서 관리형 실제 유디피 클라이언트 소켓을 만든다.
async function handleUdpLabClientBind(req, res) {
  try {
    const body = await readJsonBody(req);
    await udpLab.bindManagedClient(body);
    respondUdpLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 선택한 관리형 소켓 하나에서 유디피 데이터그램 하나를 보낸다.
async function handleUdpLabSocketSend(req, res) {
  try {
    const body = await readJsonBody(req);
    await udpLab.send(body.socketId, body.text, {
      host: body.host,
      port: body.port,
    });
    respondUdpLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 선택한 유디피 소켓 하나를 닫는다.
async function handleUdpLabSocketClose(req, res) {
  try {
    const body = await readJsonBody(req);
    await udpLab.closeSocket(body.socketId);
    respondUdpLabState(res, 202);
  } catch (error) {
    respondJson(res, 400, { ok: false, error: error.message });
  }
}

// 이 프로젝트의 모든 페이지, 데모 요청, 실험실 요청을 분기하는 메인 웹 라우터다.
const server = http.createServer((req, res) => {
  // 주소가 없는 요청은 분기할 수 없으므로 바로 거절한다.
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  // 모든 분기 비교에서 경로 이름을 쓰기 위해 요청 주소를 한 번만 해석한다.
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 새 티시피 단계형 데모 세션을 시작한다.
  if (req.method === "POST" && url.pathname === "/demo/tcp/start") {
    handleDemoStart(req, res);
    return;
  }

  // 티시피 단계형 데모를 다음 단계로 진행한다.
  if (req.method === "POST" && url.pathname === "/demo/tcp/next") {
    handleDemoNext(req, res);
    return;
  }

  // 새 유디피 단계형 데모 세션을 시작한다.
  if (req.method === "POST" && url.pathname === "/demo/udp/start") {
    handleUdpDemoStart(req, res);
    return;
  }

  // 유디피 단계형 데모를 다음 단계로 진행한다.
  if (req.method === "POST" && url.pathname === "/demo/udp/next") {
    handleUdpDemoNext(req, res);
    return;
  }

  // 실제 티시피 실험실의 최신 상태 정보를 반환한다.
  if (req.method === "GET" && url.pathname === "/lab/tcp/state") {
    respondLabState(res);
    return;
  }

  // 브라우저가 티시피 실험실 변화를 실시간으로 받도록 서버 전송 이벤트 스트림을 연다.
  if (req.method === "GET" && url.pathname === "/lab/tcp/stream") {
    tcpLab.registerStream(req, res);
    return;
  }

  // 저장된 티시피 실험 로그 파일을 내려받는다.
  if (req.method === "GET" && url.pathname === "/lab/tcp/logs/download") {
    serveLabLogFile(
      res,
      TCP_LAB_LOG_FILE,
      "tcp-lab.ndjson",
      "Failed to read the TCP lab log file.",
    );
    return;
  }

  // 실험실 페이지에서 쓰는 실제 티시피 리스너를 시작한다.
  if (req.method === "POST" && url.pathname === "/lab/tcp/server/start") {
    handleLabServerStart(req, res);
    return;
  }

  // 실제 티시피 리스너를 중지하고 활성 실험실 소켓도 닫는다.
  if (req.method === "POST" && url.pathname === "/lab/tcp/server/stop") {
    handleLabServerStop(req, res);
    return;
  }

  // 서버 프로세스 안에서 관리형 티시피 클라이언트 소켓을 만들고 연결한다.
  if (req.method === "POST" && url.pathname === "/lab/tcp/client/connect") {
    handleLabClientConnect(req, res);
    return;
  }

  // 선택한 티시피 소켓 하나로 애플리케이션 데이터를 보낸다.
  if (req.method === "POST" && url.pathname === "/lab/tcp/socket/send") {
    handleLabSocketSend(req, res);
    return;
  }

  // 선택한 티시피 소켓 하나에서 정상 종료를 시작한다.
  if (req.method === "POST" && url.pathname === "/lab/tcp/socket/end") {
    handleLabSocketEnd(req, res);
    return;
  }

  // 선택한 티시피 소켓 하나를 강제로 끊는다.
  if (req.method === "POST" && url.pathname === "/lab/tcp/socket/destroy") {
    handleLabSocketDestroy(req, res);
    return;
  }

  // 실제 유디피 실험실의 최신 상태 정보를 반환한다.
  if (req.method === "GET" && url.pathname === "/lab/udp/state") {
    respondUdpLabState(res);
    return;
  }

  // 브라우저가 유디피 실험실 변화를 실시간으로 받도록 서버 전송 이벤트 스트림을 연다.
  if (req.method === "GET" && url.pathname === "/lab/udp/stream") {
    udpLab.registerStream(req, res);
    return;
  }

  // 저장된 유디피 실험 로그 파일을 내려받는다.
  if (req.method === "GET" && url.pathname === "/lab/udp/logs/download") {
    serveLabLogFile(
      res,
      UDP_LAB_LOG_FILE,
      "udp-lab.ndjson",
      "Failed to read the UDP lab log file.",
    );
    return;
  }

  // 실험실 페이지에서 쓰는 실제 유디피 서버 소켓을 시작한다.
  if (req.method === "POST" && url.pathname === "/lab/udp/server/start") {
    handleUdpLabServerStart(req, res);
    return;
  }

  // 실제 유디피 서버 소켓을 중지하고 활성 실험실 소켓도 닫는다.
  if (req.method === "POST" && url.pathname === "/lab/udp/server/stop") {
    handleUdpLabServerStop(req, res);
    return;
  }

  // 서버 프로세스 안에서 관리형 유디피 클라이언트 소켓을 만들고 바인드한다.
  if (req.method === "POST" && url.pathname === "/lab/udp/client/bind") {
    handleUdpLabClientBind(req, res);
    return;
  }

  // 선택한 실험실 유디피 소켓 하나로 데이터그램 하나를 보낸다.
  if (req.method === "POST" && url.pathname === "/lab/udp/socket/send") {
    handleUdpLabSocketSend(req, res);
    return;
  }

  // 선택한 유디피 소켓 하나를 닫는다.
  if (req.method === "POST" && url.pathname === "/lab/udp/socket/close") {
    handleUdpLabSocketClose(req, res);
    return;
  }

  // 어떤 요청 분기에도 걸리지 않으면 정적 파일 요청으로 처리한다.
  serveStatic(req, res);
});

server.listen(WEB_PORT, HOST, () => {
  console.log(`Visualizer running at http://${HOST}:${WEB_PORT}`);
});
