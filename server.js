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
const roundSecondsPerPlayer = Math.max(1, Number.parseInt(process.env.ROUND_SECONDS_PER_PLAYER, 10) || 60);
const accusationVoteSeconds = Math.max(1, Number.parseInt(process.env.ACCUSATION_VOTE_SECONDS, 10) || 60);
const playerHeartbeatTimeout = 2 * 60_000;
const roomIdleTimeout = 30 * 60_000;

app.use(express.json({ limit: '32kb' }));

function normalizePlayerName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function createRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => roomCodeAlphabet[Math.floor(Math.random() * roomCodeAlphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function serializeRoom(room, viewerId) {
  return {
    code: room.code,
    isHost: room.hostId === viewerId,
    players: room.players.map(({ id, seatId, name }) => ({ id: seatId, name, isHost: id === room.hostId }))
  };
}

function updateRoundStatus(room) {
  const round = room.round;
  if (round?.status === 'playing' && round.pausedRemainingMs === null && Date.now() >= round.deadlineAt) {
    round.status = 'voting';
    round.deadlineAt = null;
    round.voteDeadlineAt = Date.now() + accusationVoteSeconds * 1000;
    room.lastActivity = Date.now();
  }

  if (round?.status === 'voting' && Date.now() >= round.voteDeadlineAt) {
    const activePlayerIds = new Set(room.players.map((player) => player.id));
    const voteCounts = {};
    for (const [voterId, accusedId] of Object.entries(round.votesByPlayer)) {
      if (activePlayerIds.has(voterId) && activePlayerIds.has(accusedId)) {
        voteCounts[accusedId] = (voteCounts[accusedId] || 0) + 1;
      }
    }
    const highestVoteCount = Math.max(0, ...Object.values(voteCounts));
    const leaders = Object.entries(voteCounts)
      .filter(([, count]) => count === highestVoteCount)
      .map(([playerId]) => playerId);

    if (highestVoteCount === 0 || leaders.length !== 1) {
      finishRound(room, 'spy', highestVoteCount === 0
        ? 'The field team did not submit any votes before time ran out.'
        : 'The field team tied its top votes, so the mole escaped.');
    } else {
      const accused = getRoomPlayer(room, leaders[0]);
      const correct = leaders[0] === round.spyId;
      finishRound(room, correct ? 'agents' : 'spy', correct
        ? `${accused.name} received the most votes and was correctly identified.`
        : `${accused.name} received the most votes, but the mole was ${getRoomPlayer(room, round.spyId)?.name || 'Unknown agent'}.`);
    }
  }
}

function serializeRound(room, playerId) {
  const round = room.round;
  if (!round) return null;
  updateRoundStatus(room);

  const role = round.rolesByPlayer[playerId] || null;
  const millisecondsRemaining = round.status === 'playing'
    ? round.pausedRemainingMs !== null
      ? round.pausedRemainingMs
      : Math.max(0, round.deadlineAt - Date.now())
    : round.status === 'voting'
      ? Math.max(0, round.voteDeadlineAt - Date.now())
      : 0;
  const voteCounts = {};
  for (const accusedId of Object.values(round.votesByPlayer)) {
    const accused = getRoomPlayer(room, accusedId);
    if (accused) voteCounts[accused.seatId] = (voteCounts[accused.seatId] || 0) + 1;
  }

  return {
    number: round.number,
    status: round.status,
    locations: round.locationChoices.map(({ name }) => name),
    role,
    isSpy: playerId === round.spyId,
    location: playerId === round.spyId ? null : round.location.name,
    secondsPerPlayer: roundSecondsPerPlayer,
    accusationVoteSeconds,
    remainingSeconds: Math.ceil(millisecondsRemaining / 1000),
    paused: round.pausedRemainingMs !== null,
    voteCounts,
    myVoteId: getRoomPlayer(room, round.votesByPlayer[playerId])?.seatId || null,
    result: round.result
  };
}

function cleanLocationCatalog(value) {
  if (!Array.isArray(value)) return [];
  const locations = value.map((location) => {
    const name = typeof location?.name === 'string' ? location.name.trim().slice(0, 64) : '';
    const roles = Array.isArray(location?.roles)
      ? location.roles.filter((role) => typeof role === 'string' && role.trim()).map((role) => role.trim().slice(0, 48))
      : [];
    return { name, roles };
  }).filter((location) => location.name && location.roles.length);
  return [...new Map(locations.map((location) => [location.name.toLowerCase(), location])).values()];
}

function getRoomPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function finishRound(room, winner, reason) {
  const round = room.round;
  round.status = 'finished';
  round.deadlineAt = null;
  round.voteDeadlineAt = null;
  round.pausedRemainingMs = null;
  round.result = {
    winner,
    reason,
    location: round.location.name,
    spy: getRoomPlayer(room, round.spyId)?.name || 'Unknown agent'
  };
  room.lastActivity = Date.now();
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
    players: [{ id: playerId, seatId: randomUUID(), name, lastSeen: now }],
    round: null,
    lastActivity: now
  };
  rooms.set(code, room);
  return response.status(201).json({ room: serializeRoom(room, playerId), playerId });
});

app.post('/api/rooms/:code/join', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room || Date.now() - room.lastActivity > roomIdleTimeout) {
    rooms.delete(String(request.params.code).toUpperCase());
    return response.status(404).json({ error: 'Room not found. Check the code or create a new room.' });
  }

  updateRoundStatus(room);
  if (room.round && ['playing', 'voting'].includes(room.round.status)) {
    return response.status(409).json({ error: 'A round is already active. Join after the debrief.' });
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
    return response.json({ room: serializeRoom(room, existingPlayer.id), playerId: existingPlayer.id });
  }

  if (room.players.length >= maxPlayersPerRoom) {
    return response.status(409).json({ error: 'This room already has 10 agents.' });
  }

  const playerId = randomUUID();
  const now = Date.now();
  room.players.push({ id: playerId, seatId: randomUUID(), name, lastSeen: now });
  room.lastActivity = now;
  return response.status(201).json({ room: serializeRoom(room, playerId), playerId });
});

app.get('/api/rooms/:code', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room || Date.now() - room.lastActivity > roomIdleTimeout) {
    rooms.delete(String(request.params.code).toUpperCase());
    return response.status(404).json({ error: 'This room has expired.' });
  }

  const playerId = String(request.query.playerId || '');
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) return response.status(403).json({ error: 'Join this room before viewing its game.' });
  player.lastSeen = Date.now();
  room.lastActivity = Date.now();
  pruneInactivePlayers(room);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return response.status(404).json({ error: 'This room has expired.' });
  }
  return response.json({ room: serializeRoom(room, playerId), round: serializeRound(room, playerId) });
});

app.post('/api/rooms/:code/start', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room) return response.status(404).json({ error: 'Room not found.' });

  const playerId = String(request.body?.playerId || '');
  if (!getRoomPlayer(room, playerId)) return response.status(403).json({ error: 'Join this room before starting a round.' });
  if (room.hostId !== playerId) return response.status(403).json({ error: 'Only the host can start a round.' });
  if (room.players.length < 3) return response.status(400).json({ error: 'At least 3 agents are needed to start.' });
  if (room.round && room.round.status !== 'finished') return response.status(409).json({ error: 'A round is already in progress.' });

  const locations = cleanLocationCatalog(request.body?.locations);
  if (locations.length < 12) return response.status(400).json({ error: 'The location catalog must contain at least 12 valid locations.' });

  const locationChoices = shuffle(locations).slice(0, 12);
  const location = locationChoices[Math.floor(Math.random() * locationChoices.length)];
  const spyId = room.players[Math.floor(Math.random() * room.players.length)].id;
  const rolePool = shuffle(location.roles);
  let roleIndex = 0;
  const rolesByPlayer = {};
  for (const player of shuffle(room.players)) {
    rolesByPlayer[player.id] = player.id === spyId ? 'The Mole' : rolePool[roleIndex++ % rolePool.length];
  }

  room.round = {
    number: (room.round?.number || 0) + 1,
    status: 'playing',
    locationChoices,
    location,
    spyId,
    rolesByPlayer,
    deadlineAt: Date.now() + room.players.length * roundSecondsPerPlayer * 1000,
    pausedRemainingMs: null,
    voteDeadlineAt: null,
    votesByPlayer: {},
    result: null
  };
  room.lastActivity = Date.now();
  return response.status(201).json({ room: serializeRoom(room, playerId), round: serializeRound(room, playerId) });
});

app.post('/api/rooms/:code/timer', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room) return response.status(404).json({ error: 'Room not found.' });

  const playerId = String(request.body?.playerId || '');
  if (room.hostId !== playerId) return response.status(403).json({ error: 'Only the host can control the timer.' });
  if (!room.round) return response.status(409).json({ error: 'There is no active round.' });
  updateRoundStatus(room);

  const round = room.round;
  const action = request.body?.action;
  if (action === 'pause' && round.status === 'playing' && round.pausedRemainingMs === null) {
    round.pausedRemainingMs = Math.max(0, round.deadlineAt - Date.now());
    round.deadlineAt = null;
  } else if (action === 'resume' && round.status === 'playing' && round.pausedRemainingMs !== null) {
    round.deadlineAt = Date.now() + round.pausedRemainingMs;
    round.pausedRemainingMs = null;
  } else if (action === 'reset' && round.status === 'playing') {
    round.status = 'playing';
    round.deadlineAt = Date.now() + room.players.length * roundSecondsPerPlayer * 1000;
    round.pausedRemainingMs = null;
    round.result = null;
  } else {
    return response.status(409).json({ error: 'That timer action is not available now.' });
  }

  room.lastActivity = Date.now();
  return response.json({ room: serializeRoom(room, playerId), round: serializeRound(room, playerId) });
});

app.post('/api/rooms/:code/guess', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room) return response.status(404).json({ error: 'Room not found.' });

  const playerId = String(request.body?.playerId || '');
  const round = room.round;
  if (!getRoomPlayer(room, playerId)) return response.status(403).json({ error: 'Join this room before guessing.' });
  if (!round || round.status !== 'playing') return response.status(409).json({ error: 'The spy cannot guess now.' });
  updateRoundStatus(room);
  if (round.status !== 'playing') return response.status(409).json({ error: 'Time is up; the field team must accuse.' });
  if (round.spyId !== playerId) return response.status(403).json({ error: 'Only the mole can guess the location.' });

  const guess = typeof request.body?.location === 'string' ? request.body.location : '';
  if (!round.locationChoices.some((location) => location.name === guess)) {
    return response.status(400).json({ error: 'Choose one of the 12 locations on the board.' });
  }

  const correct = guess === round.location.name;
  finishRound(room, correct ? 'spy' : 'agents', correct
    ? 'The mole correctly identified the hidden location.'
    : `The mole guessed ${guess} and missed.`);
  return response.json({ room: serializeRoom(room), round: serializeRound(room, playerId) });
});

app.post('/api/rooms/:code/vote', (request, response) => {
  const room = findRoom(request.params.code);
  if (!room) return response.status(404).json({ error: 'Room not found.' });

  const playerId = String(request.body?.playerId || '');
  const round = room.round;
  if (!getRoomPlayer(room, playerId)) return response.status(403).json({ error: 'Join this room before voting.' });
  if (!round) return response.status(409).json({ error: 'There is no active round.' });
  updateRoundStatus(room);
  if (round.status !== 'voting') return response.status(409).json({ error: 'Voting opens when the round timer expires.' });

  const accusedSeatId = String(request.body?.accusedSeatId || '');
  const accused = room.players.find((player) => player.seatId === accusedSeatId);
  if (!accused) return response.status(400).json({ error: 'Choose an agent in this room.' });

  round.votesByPlayer[playerId] = accused.id;
  room.lastActivity = Date.now();
  return response.json({ room: serializeRoom(room, playerId), round: serializeRound(room, playerId) });
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