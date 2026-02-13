const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const WEB_CLIENT_URL = 'https://web-client-pi-two.vercel.app/';
// ===================

// Store active connections
const clients = new Map();
const streams = new Map();

// -------- REST API --------
app.get('/', (req, res) => {
  res.send(`
    <h1>WebRTC Signaling Server</h1>
    <p>Status: Running ✓</p>
    <p>Active Clients: ${clients.size}</p>
    <p>Active Streams: ${streams.size}</p>
    <p><strong>Open Web Client:</strong>
      <a href="${WEB_CLIENT_URL}" target="_blank">
        ${WEB_CLIENT_URL}
      </a>
    </p>
    <p>WebSocket endpoint: <strong>wss://${req.headers.host}</strong></p>
  `);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeClients: clients.size,
    activeStreams: streams.size
  });
});

app.get('/api/streams', (req, res) => {
  const streamList = Array.from(streams.values()).map(stream => ({
    id: stream.id,
    streamerId: stream.streamerId,
    createdAt: stream.createdAt,
    viewerCount: stream.viewers.size
  }));
  res.json({ streams: streamList });
});

// -------- WebSocket --------
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  console.log(`Client connected: ${clientId}`);

  clients.set(clientId, {
    id: clientId,
    ws,
    type: null,
    streamId: null
  });

  ws.send(JSON.stringify({
    type: 'connected',
    clientId
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(clientId, data);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => handleDisconnect(clientId));
  ws.on('error', () => handleDisconnect(clientId));
});

// -------- Message Router --------
function handleMessage(clientId, data) {
  switch (data.type) {
    case 'register-streamer': return registerStreamer(clientId, data);
    case 'register-viewer': return registerViewer(clientId, data);
    case 'offer': return relay(clientId, data, 'offer');
    case 'answer': return relay(clientId, data, 'answer');
    case 'ice-candidate': return relay(clientId, data, 'ice-candidate');
    case 'stop-stream': return stopStream(clientId);
  }
}

// -------- Streamer --------
function registerStreamer(clientId, data) {
  const client = clients.get(clientId);
  const streamId = data.streamId || uuidv4();

  if (streams.has(streamId)) {
    return client.ws.send(JSON.stringify({
      type: 'error',
      message: 'Stream ID already exists'
    }));
  }

  client.type = 'streamer';
  client.streamId = streamId;

  streams.set(streamId, {
    id: streamId,
    streamerId: clientId,
    createdAt: new Date().toISOString(),
    viewers: new Set()
  });

  client.ws.send(JSON.stringify({
    type: 'registered',
    role: 'streamer',
    streamId,
    embedUrl: `${WEB_CLIENT_URL}?streamId=${streamId}`
  }));

  console.log(`Streamer ${clientId} → ${streamId}`);
}

// -------- Viewer --------
function registerViewer(clientId, data) {
  const client = clients.get(clientId);
  const stream = streams.get(data.streamId);

  if (!stream) {
    return client.ws.send(JSON.stringify({
      type: 'error',
      message: 'Stream not found'
    }));
  }

  client.type = 'viewer';
  client.streamId = data.streamId;
  stream.viewers.add(clientId);

  client.ws.send(JSON.stringify({
    type: 'registered',
    role: 'viewer',
    streamId: data.streamId
  }));

  const streamer = clients.get(stream.streamerId);
  streamer?.ws.send(JSON.stringify({
    type: 'viewer-joined',
    viewerId: clientId
  }));
}

// -------- WebRTC Relay --------
function relay(senderId, data, type) {
  const target = clients.get(data.targetId);
  if (!target) return;

  target.ws.send(JSON.stringify({
    type,
    senderId,
    [type === 'ice-candidate' ? 'candidate' : type]: data[type]
  }));
}

// -------- Stop Stream --------
function stopStream(clientId) {
  const client = clients.get(clientId);
  if (!client?.streamId) return;

  const stream = streams.get(client.streamId);
  if (!stream) return;

  stream.viewers.forEach(viewerId => {
    const viewer = clients.get(viewerId);
    viewer?.ws.send(JSON.stringify({ type: 'stream-ended' }));
  });

  streams.delete(client.streamId);
}

// -------- Disconnect --------
function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.type === 'streamer') stopStream(clientId);

  if (client.type === 'viewer') {
    const stream = streams.get(client.streamId);
    stream?.viewers.delete(clientId);
  }

  clients.delete(clientId);
}

// -------- Start Server --------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling Server running on port ${PORT}`);
});
