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

// Store active connections
const clients = new Map();
const streams = new Map();

// REST API endpoints
app.get('/', (req, res) => {
  res.send(`
    <h1>WebRTC Signaling Server</h1>
    <p>Status: Running ✓</p>
    <p>Active Clients: ${clients.size}</p>
    <p>Active Streams: ${streams.size}</p>
    <p><strong>To view streams, go to: <a href="http://${req.headers.host.split(':')[0]}:3001">Web Client</a></strong></p>
    <p>WebSocket endpoint: ws://${req.headers.host}</p>
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

// WebSocket connection handler
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  console.log(`New client connected: ${clientId}`);

  clients.set(clientId, {
    id: clientId,
    ws: ws,
    type: null, // 'streamer' or 'viewer'
    streamId: null
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(clientId, data);
    } catch (error) {
      console.error('Error parsing message:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    handleDisconnect(clientId);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
  });

  // Send welcome message with client ID
  ws.send(JSON.stringify({
    type: 'connected',
    clientId: clientId
  }));
});

function handleMessage(clientId, data) {
  const client = clients.get(clientId);
  if (!client) return;

  console.log(`Message from ${clientId}:`, data.type);

  switch (data.type) {
    case 'register-streamer':
      handleRegisterStreamer(clientId, data);
      break;

    case 'register-viewer':
      handleRegisterViewer(clientId, data);
      break;

    case 'offer':
      handleOffer(clientId, data);
      break;

    case 'answer':
      handleAnswer(clientId, data);
      break;

    case 'ice-candidate':
      handleIceCandidate(clientId, data);
      break;

    case 'stop-stream':
      handleStopStream(clientId);
      break;

    default:
      console.log(`Unknown message type: ${data.type}`);
  }
}

function handleRegisterStreamer(clientId, data) {
  const client = clients.get(clientId);
  const streamId = data.streamId || uuidv4();

  // Check if streamId is already in use by another ACTIVE streamer
  if (streams.has(streamId)) {
    console.log(`Registration failed: Stream ID '${streamId}' is already in use.`);
    client.ws.send(JSON.stringify({
      type: 'error',
      message: `Stream ID '${streamId}' is already in use. Please choose another name.`
    }));
    return;
  }

  client.type = 'streamer';
  client.streamId = streamId;

  streams.set(streamId, {
    id: streamId,
    streamerId: clientId,
    createdAt: new Date().toISOString(),
    viewers: new Set()
  });

  console.log(`Streamer registered: ${clientId}, stream: ${streamId}`);

  client.ws.send(JSON.stringify({
    type: 'registered',
    role: 'streamer',
    streamId: streamId,
    embedUrl: `${getBaseUrl()}?streamId=${streamId}`
  }));
}

function handleRegisterViewer(clientId, data) {
  const client = clients.get(clientId);
  const streamId = data.streamId;

  if (!streamId || !streams.has(streamId)) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: 'Stream not found'
    }));
    return;
  }

  client.type = 'viewer';
  client.streamId = streamId;

  const stream = streams.get(streamId);
  stream.viewers.add(clientId);

  console.log(`Viewer registered: ${clientId}, stream: ${streamId}`);

  client.ws.send(JSON.stringify({
    type: 'registered',
    role: 'viewer',
    streamId: streamId
  }));

  // Notify streamer about new viewer
  const streamer = clients.get(stream.streamerId);
  if (streamer && streamer.ws.readyState === WebSocket.OPEN) {
    streamer.ws.send(JSON.stringify({
      type: 'viewer-joined',
      viewerId: clientId
    }));
  }
}

function handleOffer(clientId, data) {
  const targetId = data.targetId;
  const target = clients.get(targetId);

  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify({
      type: 'offer',
      offer: data.offer,
      senderId: clientId
    }));
  }
}

function handleAnswer(clientId, data) {
  const targetId = data.targetId;
  const target = clients.get(targetId);

  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify({
      type: 'answer',
      answer: data.answer,
      senderId: clientId
    }));
  }
}

function handleIceCandidate(clientId, data) {
  const targetId = data.targetId;
  const target = clients.get(targetId);

  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify({
      type: 'ice-candidate',
      candidate: data.candidate,
      senderId: clientId
    }));
  }
}

function handleStopStream(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.streamId) return;

  const stream = streams.get(client.streamId);
  if (!stream) return;

  // Notify all viewers
  stream.viewers.forEach(viewerId => {
    const viewer = clients.get(viewerId);
    if (viewer && viewer.ws.readyState === WebSocket.OPEN) {
      viewer.ws.send(JSON.stringify({
        type: 'stream-ended'
      }));
    }
  });

  streams.delete(client.streamId);
  console.log(`Stream ended: ${client.streamId}`);
}

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  console.log(`Client disconnected: ${clientId}`);

  if (client.type === 'streamer' && client.streamId) {
    handleStopStream(clientId);
  } else if (client.type === 'viewer' && client.streamId) {
    const stream = streams.get(client.streamId);
    if (stream) {
      stream.viewers.delete(clientId);

      // Notify streamer
      const streamer = clients.get(stream.streamerId);
      if (streamer && streamer.ws.readyState === WebSocket.OPEN) {
        streamer.ws.send(JSON.stringify({
          type: 'viewer-left',
          viewerId: clientId
        }));
      }
    }
  }

  clients.delete(clientId);
}

function getBaseUrl() {
  const port = process.env.PORT || 3000;
  return process.env.PUBLIC_URL || `http://localhost:${port}`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
