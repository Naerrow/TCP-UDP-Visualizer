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
  return (value || "event").replace(/_/g, " ");
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
  const parts = [event.label || event.category, prettify(event.action)];
  return parts.filter(Boolean).join(" / ");
}

function logDetail(event) {
  const details = [];
  if (event.detail) {
    details.push(event.detail);
  }

  const local = formatEndpoint(event.localAddress, event.localPort);
  const remote = formatEndpoint(event.remoteAddress, event.remotePort);
  if (local !== "-" || remote !== "-") {
    details.push(`local=${local} remote=${remote}`);
  }

  return details.join(" ");
}

function renderLogItem(event) {
  const node = logTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".event-type").textContent = `${prettify(event.category)} / ${prettify(event.action)}`;
  node.querySelector(".event-time").textContent = formatClock(event.at);
  node.querySelector(".event-title").textContent = logTitle(event);
  node.querySelector(".event-detail").textContent = logDetail(event);

  const payload = node.querySelector(".log-payload");
  if (typeof event.bytes === "number") {
    payload.hidden = false;
    payload.textContent = `bytes: ${event.bytes}\nutf8: ${event.utf8}\nhex: ${event.hex}`;
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
    row.innerHTML = '<td colspan="7" class="empty-cell">No sockets yet.</td>';
    socketTableBody.append(row);
    return;
  }

  for (const socket of sockets) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${socket.id}</td>
      <td>${socket.role}</td>
      <td>${socket.status}</td>
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
    option.textContent = "No writable sockets";
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
    option.textContent = `${socket.id} | ${socket.role} | ${formatEndpoint(socket.localAddress, socket.localPort)} -> ${formatEndpoint(socket.remoteAddress, socket.remotePort)}`;
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
    ? `Listening on ${endpoint}. 실제 TCP listener가 열려 있다.`
    : `Server stopped. ${endpoint} listener is not active.`;
}

function renderManagedClientState(snapshot) {
  const clients = activeSockets(snapshot).filter((socket) => socket.role === "managed-client");
  if (clients.length === 0) {
    managedClientStateEl.textContent = "No managed client connected yet.";
    return;
  }

  const latest = clients[0];
  managedClientStateEl.textContent = `Latest managed client: ${latest.id} ${formatEndpoint(latest.localAddress, latest.localPort)} -> ${formatEndpoint(latest.remoteAddress, latest.remotePort)} (${latest.status})`;
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
    throw new Error(data.error || `Request failed: ${response.status}`);
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
    "Starting...",
  );
});

stopServerButton.addEventListener("click", () => {
  postJson("/lab/tcp/server/stop", {}, stopServerButton, "Stopping...");
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
    "Connecting...",
  );
});

refreshButton.addEventListener("click", async () => {
  setPending(refreshButton, true, "Refreshing...");
  try {
    await refreshState();
  } catch (error) {
    window.alert(error.message);
  } finally {
    setPending(refreshButton, false, "Refreshing...");
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
    "Sending...",
  );
});

endButton.addEventListener("click", () => {
  postJson(
    "/lab/tcp/socket/end",
    {
      socketId: socketSelect.value,
    },
    endButton,
    "Closing...",
  );
});

destroyButton.addEventListener("click", () => {
  postJson(
    "/lab/tcp/socket/destroy",
    {
      socketId: socketSelect.value,
    },
    destroyButton,
    "Destroying...",
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
