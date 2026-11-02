import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const app = express();
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(projectDirectory, 'public');
const port = Number(process.env.PORT) || 3000;
const rooms = new Map();
const roomCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const maxPlayersPerRoom = 10;
const playerHeartbeatTimeout = 2 * 60_000;
const roomIdleTimeout = 30 * 60_000;

app.use(express.json({ limit: '2kb' }));

function normalizePlayerName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
}

function createRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => roomCodeAlphabet[Math.floor(Math.random() * roomCodeAlphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(({ id, name }) => ({ id, name, isHost: id === room.hostId }))
  };
}

function pruneInactivePlayers(room) {
  const cutoff = Date.now() - playerHeartbeatTimeout;
  room.players = room.players.filter((player) => player.lastSeen >= cutoff);
  if (!room.players.some((player) => player.id === room.hostId)) {
    room.hostId = room.players[0]?.id ?? null;
  }
}

function findRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

app.post('/api/rooms', (request, response) => {
  const name = normalizePlayerName(request.body?.name);
  if (!name) return response.status(400).json({ error: 'Enter an agent name to create a room.' });

  const code = createRoomCode();
  const playerId = randomUUID();
  const now = Date.now();
  const room = {
    code,
    hostId: playerId,
    players: [{ id: playerId, name, lastSeen: now }],
    lastActivity: now
  };
  rooms.set(code, room);
  return response.status(201).json({ room: serializeRoom(room), playerId });
});

app.post('/api/rooms/:code/join', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room || Date.now() - room.lastActivity > roomIdleTimeout) {
    rooms.delete(String(request.params.code).toUpperCase());
    return response.status(404).json({ error: 'Room not found. Check the code or create a new room.' });
  }

  const name = normalizePlayerName(request.body?.name);
  if (!name) return response.status(400).json({ error: 'Enter an agent name to join.' });
  pruneInactivePlayers(room);

  const requestedId = typeof request.body?.playerId === 'string' ? request.body.playerId : '';
  const existingPlayer = room.players.find((player) => player.id === requestedId);
  if (existingPlayer) {
    existingPlayer.name = name;
    existingPlayer.lastSeen = Date.now();
    room.lastActivity = Date.now();
    return response.json({ room: serializeRoom(room), playerId: existingPlayer.id });
  }

  if (room.players.length >= maxPlayersPerRoom) {
    return response.status(409).json({ error: 'This room already has 10 agents.' });
  }

  const playerId = randomUUID();
  const now = Date.now();
  room.players.push({ id: playerId, name, lastSeen: now });
  room.lastActivity = now;
  return response.status(201).json({ room: serializeRoom(room), playerId });
});

app.get('/api/rooms/:code', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room || Date.now() - room.lastActivity > roomIdleTimeout) {
    rooms.delete(String(request.params.code).toUpperCase());
    return response.status(404).json({ error: 'This room has expired.' });
  }

  const playerId = String(request.query.playerId || '');
  const player = room.players.find((entry) => entry.id === playerId);
  if (player) {
    player.lastSeen = Date.now();
    room.lastActivity = Date.now();
  }
  pruneInactivePlayers(room);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return response.status(404).json({ error: 'This room has expired.' });
  }
  return response.json({ room: serializeRoom(room) });
});

app.post('/api/rooms/:code/leave', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room) return response.json({ ok: true });

  const playerId = String(request.body?.playerId || '');
  room.players = room.players.filter((player) => player.id !== playerId);
  if (room.players.length === 0) {
    rooms.delete(room.code);
  } else {
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    room.lastActivity = Date.now();
  }
  return response.json({ ok: true });
});

app.use(express.static(publicDirectory));

setInterval(() => {
  const cutoff = Date.now() - roomIdleTimeout;
  for (const [code, room] of rooms) {
    if (room.lastActivity < cutoff) rooms.delete(code);
    else pruneInactivePlayers(room);
  }
}, roomIdleTimeout).unref();

app.listen(port, '0.0.0.0', () => {
  console.log(`Mole Hunt listening on port ${port}`);
});