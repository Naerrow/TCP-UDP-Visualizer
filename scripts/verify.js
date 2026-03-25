const http = require("http");

const WEB_PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: WEB_PORT,
        path,
        method: "POST",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`${path} failed with ${res.statusCode}: ${body}`));
            return;
          }
          resolve(body ? JSON.parse(body) : {});
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

function hasRequiredEvent(events, requirement) {
  return events.some((event) => {
    const value = event.label || event.title || "";
    if (typeof requirement === "string") {
      return value === requirement;
    }
    if (requirement.type && event.type !== requirement.type) {
      return false;
    }
    if (requirement.includes) {
      return value.includes(requirement.includes);
    }
    return false;
  });
}

async function verifyProtocol(protocol, steps, completionTitle, requiredLabels) {
  const events = [];

  const started = await request(`/demo/${protocol}/start`);
  events.push(...(started.events || []));

  for (let i = 0; i < steps; i += 1) {
    const result = await request(`/demo/${protocol}/next`);
    events.push(...(result.events || []));
  }

  const protocolEvents = events.filter(
    (event) => event.protocol === protocol.toUpperCase(),
  );

  if (!hasRequiredEvent(protocolEvents, completionTitle)) {
    throw new Error(`${protocol} did not complete`);
  }

  for (const requirement of requiredLabels) {
    if (!hasRequiredEvent(protocolEvents, requirement)) {
      throw new Error(`${protocol} missing event: ${JSON.stringify(requirement)}`);
    }
  }
}

async function main() {
  await verifyProtocol("tcp", 15, "TCP 세션 종료", [
    "BIND",
    "LISTEN + ACCEPT WAIT",
    "connect()",
    "SYN",
    "SYN-ACK",
    "ACK",
    "connect() returned",
    "accept() returned",
    "ESTABLISHED",
    "write #1 / 4B",
    "write #2 / 4B",
    "APP WRITES x2 / 2 records",
    { type: "read", includes: "read #" },
    { includes: "READ BUFFER /" },
    "close() / FIN",
    "FIN RECEIVED / ACK IMPLIED",
    "server close() / FIN",
    "FINAL ACK IMPLIED / CLOSED",
  ]);

  await verifyProtocol("udp", 11, "UDP 세션 종료", [
    "BIND",
    "RECVFROM WAIT",
    "socket() + bind()",
    "NO HANDSHAKE / NO ACCEPT",
    "send() #1 / 4B",
    "recvfrom() #1 / 4B",
    "send() #2 / 4B",
    "recvfrom() #2 / 4B",
    "DATAGRAM BOUNDARIES PRESERVED",
    { includes: "send() reply /" },
    { includes: "recvfrom() reply /" },
    "close() / NO FIN",
  ]);

  console.log("verification passed");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
