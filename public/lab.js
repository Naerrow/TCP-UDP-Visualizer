const serverStateEl = document.getElementById("lab-server-state");
const managedClientStateEl = document.getElementById("managed-client-state");
const listenerAddressEl = document.getElementById("listener-address");
const logFilePathEl = document.getElementById("log-file-path");
const labHostInput = document.getElementById("lab-host");
const labPortInput = document.getElementById("lab-port");
const clientHostInput = document.getElementById("client-host");
const clientPortInput = document.getElementById("client-port");
const clientLabelInput = document.getElementById("client-label");
const socketSelect = document.getElementById("socket-select");
const socketMessage = document.getElementById("socket-message");
const socketTableBody = document.getElementById("socket-table-body");
const labLog = document.getElementById("lab-log");
const logTemplate = document.getElementById("lab-log-item-template");
const commandNetcat = document.getElementById("command-netcat");
const commandLsof = document.getElementById("command-lsof");
const commandTail = document.getElementById("command-tail");
const commandTcpdump = document.getElementById("command-tcpdump");

const startServerButton = document.getElementById("start-lab-server");
const stopServerButton = document.getElementById("stop-lab-server");
const connectClientButton = document.getElementById("connect-managed-client");
const refreshButton = document.getElementById("refresh-lab");
const sendButton = document.getElementById("send-socket-message");
const endButton = document.getElementById("end-socket");
const destroyButton = document.getElementById("destroy-socket");

const uiState = {
  snapshot: null,
};

function prettify(value) {
  return (value || "event").replace(/[_-]/g, " ");
}

function formatClock(at) {
  return new Date(at).toLocaleTimeString("ko-KR", { hour12: false });
}

function formatEndpoint(address, port) {
  if (!address || !port) {
    return "-";
  }

  return `${address}:${port}`;
}

function activeSockets(snapshot) {
  return (snapshot?.sockets || []).filter((socket) => socket.status !== "closed");
}

function writableSockets(snapshot) {
  return activeSockets(snapshot).filter((socket) => socket.status !== "half-closed");
}

function setPending(button, pending, label) {
  button.textContent = pending ? label : button.dataset.label;
  button.disabled = pending;
}

function applyButtonLabels() {
  for (const button of [
    startServerButton,
    stopServerButton,
    connectClientButton,
    refreshButton,
    sendButton,
    endButton,
    destroyButton,
  ]) {
    button.dataset.label = button.textContent;
  }
}

function logTitle(event) {
  const parts = [displayCategory(event.category), "상세 로그"];
  return parts.filter(Boolean).join(" / ");
}

function displayCategory(category) {
  switch (category) {
    case "server":
      return "서버";
    case "client":
      return "클라이언트";
    case "socket":
      return "소켓";
    default:
      return prettify(category);
  }
}

function displayAction(action) {
  switch (action) {
    case "listening":
      return "리스닝";
    case "accepted":
      return "연결 수락";
    case "connect-request":
      return "연결 시도";
    case "connected":
      return "연결 완료";
    case "write":
      return "전송";
    case "data":
      return "수신";
    case "end-request":
      return "종료 요청";
    case "end":
      return "FIN 관찰";
    case "close":
      return "닫힘";
    case "destroy":
      return "강제 종료";
    case "stopped":
      return "리스너 중지";
    case "error":
      return "오류";
    default:
      return prettify(action);
  }
}

function displayLabel(label) {
  switch (label) {
    case "Accepted peer":
    case "수락된 연결":
    case "서버 소켓":
      return "서버 소켓";
    case "Managed client":
    case "관리형 클라이언트":
    case "클라이언트":
      return "클라이언트";
    default:
      return label;
  }
}

function subjectFor(event) {
  const parts = [];

  if (event.label) {
    parts.push(displayLabel(event.label));
  } else if (event.category === "server") {
    parts.push("서버");
  } else if (event.category === "client") {
    parts.push("클라이언트");
  } else {
    parts.push("소켓");
  }

  if (event.role) {
    const roleLabel = displayRole(event.role);
    if (roleLabel && roleLabel !== parts[parts.length - 1]) {
      parts.push(roleLabel);
    }
  }

  return parts.join(" · ");
}

function summaryFor(event) {
  switch (event.action) {
    case "listening":
      return `${event.host}:${event.port} 에서 리스닝을 시작했다.`;
    case "accepted":
      return "서버가 실제 TCP 연결을 수락했다.";
    case "connect-request":
      return "클라이언트가 TCP 연결 시도를 시작했다.";
    case "connected":
      return "TCP 연결이 성립됐다.";
    case "write":
      return `${subjectFor(event)} 가 ${event.bytes}B 를 보냈다.`;
    case "data":
      return `${subjectFor(event)} 가 ${event.bytes}B 를 받았다.`;
    case "end-request":
      return `${subjectFor(event)} 가 FIN 전송으로 정상 종료를 시작했다.`;
    case "end":
      return `${subjectFor(event)} 가 상대 FIN 을 관찰했다.`;
    case "close":
      return `${subjectFor(event)} 소켓이 닫혔다.`;
    case "destroy":
      return `${subjectFor(event)} 가 소켓을 즉시 종료했다.`;
    case "stopped":
      return "TCP 실험용 리스너가 중지됐다.";
    case "error":
      return event.message || event.detail || "소켓 오류가 발생했다.";
    default:
      return event.detail || `${prettify(event.action)} 이벤트`;
  }
}

function logDetail(event) {
  const details = [];

  if (event.socketId) {
    details.push(`소켓=${event.socketId}`);
  }

  if (event.detail) {
    details.push(event.detail);
  }

  const local = formatEndpoint(event.localAddress, event.localPort);
  const remote = formatEndpoint(event.remoteAddress, event.remotePort);
  if (local !== "-" || remote !== "-") {
    details.push(`로컬=${local} 원격=${remote}`);
  }

  return details.join(" ");
}

function renderLogItem(event) {
  const node = logTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.action = event.action || "generic";
  node.querySelector(".event-type").textContent = `${displayCategory(event.category)} / ${displayAction(event.action)}`;
  node.querySelector(".event-time").textContent = formatClock(event.at);
  node.querySelector(".log-subject").textContent = subjectFor(event);
  node.querySelector(".log-summary").textContent = summaryFor(event);
  node.querySelector(".event-title").textContent = logTitle(event);
  node.querySelector(".event-detail").textContent = logDetail(event);

  const payload = node.querySelector(".log-payload");
  if (typeof event.bytes === "number") {
    payload.hidden = false;
    payload.textContent = `바이트 수: ${event.bytes}\nUTF-8: ${event.utf8}\n16진수: ${event.hex}`;
  }

  return node;
}

function renderLogs(logs) {
  labLog.innerHTML = "";
  logs
    .slice()
    .reverse()
    .forEach((event) => {
      labLog.append(renderLogItem(event));
    });
}

function renderSocketTable(sockets) {
  socketTableBody.innerHTML = "";

  if (sockets.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="7" class="empty-cell">아직 생성된 소켓이 없다.</td>';
    socketTableBody.append(row);
    return;
  }

  for (const socket of sockets) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${socket.id}</td>
      <td>${displayRole(socket.role)}</td>
      <td>${displayStatus(socket.status)}</td>
      <td>${formatEndpoint(socket.localAddress, socket.localPort)}</td>
      <td>${formatEndpoint(socket.remoteAddress, socket.remotePort)}</td>
      <td>${socket.bytesRead}</td>
      <td>${socket.bytesWritten}</td>
    `;
    socketTableBody.append(row);
  }
}

function renderSocketOptions(snapshot) {
  const previous = socketSelect.value;
  const sockets = writableSockets(snapshot);
  socketSelect.innerHTML = "";

  if (sockets.length === 0) {
    const option = document.createElement("option");
    option.textContent = "전송 가능한 소켓이 없다";
    option.value = "";
    socketSelect.append(option);
    socketSelect.disabled = true;
    sendButton.disabled = true;
    endButton.disabled = true;
    destroyButton.disabled = true;
    return;
  }

  for (const socket of sockets) {
    const option = document.createElement("option");
    option.value = socket.id;
    option.textContent = `${socket.id} | ${displayRole(socket.role)} | ${formatEndpoint(socket.localAddress, socket.localPort)} -> ${formatEndpoint(socket.remoteAddress, socket.remotePort)}`;
    socketSelect.append(option);
  }

  if (sockets.some((socket) => socket.id === previous)) {
    socketSelect.value = previous;
  }

  socketSelect.disabled = false;
  sendButton.disabled = false;
  endButton.disabled = false;
  destroyButton.disabled = false;
}

function renderCommands(snapshot) {
  const host = snapshot?.host || "127.0.0.1";
  const port = snapshot?.port || 4200;
  const logFile = snapshot?.logFile || "logs/tcp-lab.ndjson";

  commandNetcat.textContent = `nc ${host} ${port}`;
  commandLsof.textContent = `lsof -n -P -iTCP:${port}`;
  commandTail.textContent = `tail -f ${logFile}`;
  commandTcpdump.textContent = `macOS: sudo tcpdump -i lo0 -nn tcp port ${port}\nLinux: sudo tcpdump -i lo -nn tcp port ${port}`;
}

function renderServerState(snapshot) {
  const listening = snapshot?.listening;
  const endpoint = `${snapshot?.host || "127.0.0.1"}:${snapshot?.port || 4200}`;
  listenerAddressEl.textContent = endpoint;
  logFilePathEl.textContent = snapshot?.logFile || "logs/tcp-lab.ndjson";
  serverStateEl.textContent = listening
    ? `${endpoint} 에서 실제 TCP 리스너가 열려 있다.`
    : `${endpoint} 리스너는 현재 중지 상태다.`;
}

function renderManagedClientState(snapshot) {
  const clients = activeSockets(snapshot).filter((socket) => socket.role === "managed-client");
  if (clients.length === 0) {
    managedClientStateEl.textContent = "연결된 클라이언트가 아직 없다.";
    return;
  }

  const latest = clients[0];
  managedClientStateEl.textContent = `최근 클라이언트: ${latest.id} ${formatEndpoint(latest.localAddress, latest.localPort)} -> ${formatEndpoint(latest.remoteAddress, latest.remotePort)} (${displayStatus(latest.status)})`;
}

function displayRole(role) {
  switch (role) {
    case "managed-client":
      return "클라이언트 소켓";
    case "server-peer":
      return "서버 소켓";
    default:
      return prettify(role);
  }
}

function displayStatus(status) {
  switch (status) {
    case "opening":
      return "연결 시작";
    case "open":
      return "열림";
    case "ending":
      return "종료 시작";
    case "half-closed":
      return "반쪽 종료";
    case "closed":
      return "닫힘";
    case "error":
      return "오류";
    default:
      return prettify(status);
  }
}

function syncPrimaryButtons() {
  startServerButton.disabled = Boolean(uiState.snapshot?.listening);
  stopServerButton.disabled = !uiState.snapshot?.listening;
  connectClientButton.disabled = false;
  refreshButton.disabled = false;
}

function applyState(snapshot) {
  uiState.snapshot = snapshot;

  labHostInput.value = snapshot.host || labHostInput.value;
  labPortInput.value = snapshot.port || labPortInput.value;
  clientHostInput.value = snapshot.host || clientHostInput.value;
  clientPortInput.value = snapshot.port || clientPortInput.value;

  renderServerState(snapshot);
  renderManagedClientState(snapshot);
  renderCommands(snapshot);
  renderSocketTable(snapshot.sockets || []);
  renderSocketOptions(snapshot);
  renderLogs(snapshot.logs || []);
  syncPrimaryButtons();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `요청 처리에 실패했다. (${response.status})`);
  }

  return data;
}

async function refreshState() {
  const state = await requestJson("/lab/tcp/state");
  applyState(state);
}

async function postJson(url, body, button, pendingLabel) {
  if (button) {
    setPending(button, true, pendingLabel);
  }

  try {
    const state = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body || {}),
    });
    applyState(state);
  } catch (error) {
    window.alert(error.message);
  } finally {
    if (button) {
      setPending(button, false, pendingLabel);
    }
    syncPrimaryButtons();
    syncActionButtons();
  }
}

function syncActionButtons() {
  const hasSocket = Boolean(socketSelect.value);
  if (!uiState.snapshot) {
    sendButton.disabled = true;
    endButton.disabled = true;
    destroyButton.disabled = true;
    return;
  }

  const writable = writableSockets(uiState.snapshot);
  const available = writable.some((socket) => socket.id === socketSelect.value);

  sendButton.disabled = !(hasSocket && available);
  endButton.disabled = !(hasSocket && available);
  destroyButton.disabled = !(hasSocket && available);
}

function connectStream() {
  const stream = new EventSource("/lab/tcp/stream");

  stream.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") {
      applyState(payload.state);
    }
  };

  stream.onerror = () => {
    window.setTimeout(connectStream, 1500);
    stream.close();
  };
}

startServerButton.addEventListener("click", () => {
  postJson(
    "/lab/tcp/server/start",
    {
      host: labHostInput.value,
      port: Number(labPortInput.value),
    },
    startServerButton,
    "시작 중...",
  );
});

stopServerButton.addEventListener("click", () => {
  postJson("/lab/tcp/server/stop", {}, stopServerButton, "중지 중...");
});

connectClientButton.addEventListener("click", () => {
  postJson(
    "/lab/tcp/client/connect",
    {
      host: clientHostInput.value,
      port: Number(clientPortInput.value),
      label: clientLabelInput.value,
    },
    connectClientButton,
    "연결 중...",
  );
});

refreshButton.addEventListener("click", async () => {
  setPending(refreshButton, true, "새로고침 중...");
  try {
    await refreshState();
  } catch (error) {
    window.alert(error.message);
  } finally {
    setPending(refreshButton, false, "새로고침 중...");
    syncPrimaryButtons();
    syncActionButtons();
  }
});

sendButton.addEventListener("click", () => {
  postJson(
    "/lab/tcp/socket/send",
    {
      socketId: socketSelect.value,
      text: socketMessage.value,
    },
    sendButton,
    "전송 중...",
  );
});

endButton.addEventListener("click", () => {
  postJson(
    "/lab/tcp/socket/end",
    {
      socketId: socketSelect.value,
    },
    endButton,
    "종료 중...",
  );
});

destroyButton.addEventListener("click", () => {
  postJson(
    "/lab/tcp/socket/destroy",
    {
      socketId: socketSelect.value,
    },
    destroyButton,
    "강제 종료 중...",
  );
});

socketSelect.addEventListener("change", () => {
  syncActionButtons();
});

applyButtonLabels();
refreshState().catch((error) => {
  window.alert(error.message);
});
connectStream();
