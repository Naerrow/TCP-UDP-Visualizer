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

function watchEvents() {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(`http://${HOST}:${WEB_PORT}/events`, (res) => {
      res.setEncoding("utf8");
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop();

        for (const part of parts) {
          const line = part
            .split("\n")
            .find((entry) => entry.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          events.push(event);
        }
      });

      res.on("error", reject);

      resolve({
        events,
        close: () => req.destroy(),
      });
    });

    req.on("error", reject);
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
  const stream = await watchEvents();

  try {
    await request(`/demo/${protocol}/start`);
    for (let i = 0; i < steps; i += 1) {
      await request(`/demo/${protocol}/next`);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    const protocolEvents = stream.events.filter(
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
  } finally {
    stream.close();
  }
}

async function main() {
  await verifyProtocol("tcp", 11, "TCP session completed", [
    "BIND",
    "LISTEN + ACCEPT WAIT",
    "connect()",
    "SYN -> SYN-ACK -> ACK COMPLETE",
    "ACCEPT RETURNED",
    "ESTABLISHED",
    "close() / FIN",
    "FIN RECEIVED / ACK IMPLIED",
    "server close() / FIN",
    "FINAL ACK IMPLIED / CLOSED",
  ]);

  console.log("verification passed");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
