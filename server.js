const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Domino tile generation ───────────────────────────────────────────────────
function generateTiles() {
  const tiles = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) {
      tiles.push([a, b]);
    }
  }
  return tiles;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isDouble(tile) {
  return tile[0] === tile[1];
}

function tilePips(tile) {
  return tile[0] + tile[1];
}

function beanstalkTop(beanstalk) {
  if (beanstalk.length === 0) return null;
  return beanstalk[beanstalk.length - 1][1];
}

function canPlayOn(tile, topValue) {
  return tile[0] === topValue || tile[1] === topValue;
}

function orientTile(tile, topValue) {
  // Orient so that matching end is [0] (connects down) and other end is [1] (new top)
  if (tile[0] === topValue) return [tile[0], tile[1]];
  if (tile[1] === topValue) return [tile[1], tile[0]];
  return null;
}

// ─── Room / game state ────────────────────────────────────────────────────────
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createGameState(numPlayers, tilesPerPlayer) {
  const tiles = shuffle(generateTiles());
  const hands = [];
  for (let i = 0; i < numPlayers; i++) {
    hands.push(tiles.splice(0, tilesPerPlayer));
  }
  return {
    hands,
    beanstalks: Array.from({ length: numPlayers }, () => []),
    pile: tiles,
    currentPlayer: 0,
    phase: 'playing', // playing | steal | orientation | lastChance | over
    beanedOut: Array.from({ length: numPlayers }, () => false),
    drawnThisTurn: false,
    extraTurn: false,       // magic bean extra turn
    stealPending: false,    // waiting for steal/skip
    sixChain: false,        // six chain continuation
    message: '',
    messageType: '',
  };
}

function scorePlayer(beanstalk) {
  return beanstalk.reduce((sum, t) => sum + t[0] + t[1], 0);
}

function getScores(room) {
  return room.game.beanstalks.map(scorePlayer);
}

function sendGameState(room, extraFields) {
  const g = room.game;
  room.players.forEach((p, idx) => {
    if (!p.socket) return;
    p.socket.emit('gameState', {
      yourHand: g.hands[idx],
      beanstalks: g.beanstalks,
      currentPlayer: g.currentPlayer,
      pileCount: g.pile.length,
      players: room.players.map(pl => pl.name),
      yourIdx: idx,
      scores: getScores(room),
      phase: g.phase,
      message: g.message,
      messageType: g.messageType,
      beanedOut: g.beanedOut,
      ...extraFields,
    });
  });
}

function playerHasPlay(hand, topValue) {
  if (topValue === null) return hand.length > 0; // first tile — anything goes
  return hand.some(t => canPlayOn(t, topValue));
}

function checkAllBeanedOut(room) {
  const g = room.game;
  return g.beanedOut.every(b => b) && g.pile.length === 0;
}

function advanceTurn(room) {
  const g = room.game;
  g.drawnThisTurn = false;
  g.message = '';
  g.messageType = '';

  // Check if all beaned out → last chance
  if (checkAllBeanedOut(room)) {
    startLastChance(room);
    return;
  }

  // Move to next non-beaned-out player
  let next = (g.currentPlayer + 1) % room.numPlayers;
  let loops = 0;
  while (g.beanedOut[next] && loops < room.numPlayers) {
    next = (next + 1) % room.numPlayers;
    loops++;
  }
  if (loops >= room.numPlayers) {
    startLastChance(room);
    return;
  }
  g.currentPlayer = next;
  sendGameState(room);
}

function startLastChance(room) {
  const g = room.game;
  g.phase = 'lastChance';

  // Collect all hand tiles into a pool and shuffle
  const pool = [];
  for (let i = 0; i < room.numPlayers; i++) {
    pool.push(...g.hands[i]);
    g.hands[i] = [];
  }
  shuffle(pool);

  g.message = 'Last Chance Round! All players beaned out.';
  g.messageType = 'lastChance';

  room.players.forEach((p) => {
    if (p.socket) p.socket.emit('lastChanceRound', { message: g.message });
  });

  // Each player draws one and tries to play
  for (let i = 0; i < room.numPlayers; i++) {
    if (pool.length === 0) break;
    const drawn = pool.pop();
    const top = beanstalkTop(g.beanstalks[i]);
    let canPlay = false;

    if (top === null) {
      // Empty beanstalk — can play anything
      g.beanstalks[i].push(drawn);
      canPlay = true;
    } else if (canPlayOn(drawn, top)) {
      const oriented = orientTile(drawn, top);
      g.beanstalks[i].push(oriented);
      canPlay = true;
    } else {
      g.hands[i].push(drawn);
    }

    room.players.forEach((p) => {
      if (p.socket) {
        p.socket.emit('lastChanceDraw', {
          playerIdx: i,
          playerName: room.players[i].name,
          drawn,
          canPlay,
        });
      }
    });
  }

  endGame(room);
}

function endGame(room) {
  const g = room.game;
  g.phase = 'over';
  const scores = getScores(room);
  const maxScore = Math.max(...scores);
  const winnerIdx = scores.indexOf(maxScore);

  room.players.forEach((p) => {
    if (p.socket) {
      p.socket.emit('gameOver', {
        scores,
        winner: room.players[winnerIdx].name,
        winnerIdx,
      });
    }
  });

  // Auto-cleanup after 5 minutes
  setTimeout(() => {
    delete rooms[room.code];
  }, 5 * 60 * 1000);
}

function handlePostPlay(room, playerIdx) {
  const g = room.game;
  const beanstalk = g.beanstalks[playerIdx];
  const lastTile = beanstalk[beanstalk.length - 1];
  const top = beanstalkTop(g.beanstalks[playerIdx]);

  // Auto-draw from pile after playing (if pile has tiles)
  if (g.pile.length > 0) {
    g.hands[playerIdx].push(g.pile.pop());
  }

  // Check if played tile is a double (Magic Bean)
  if (isDouble(lastTile)) {
    // Flying Dutchman (double 6)
    if (lastTile[0] === 6 && lastTile[1] === 6) {
      room.players.forEach((p) => {
        if (p.socket) p.socket.emit('flyingDutchman');
      });
    }

    // Check if any opponent has stealable tiles (non-doubles)
    const hasStealable = g.beanstalks.some((bs, idx) => {
      if (idx === playerIdx) return false;
      return bs.some(t => !isDouble(t));
    });

    if (hasStealable) {
      g.phase = 'steal';
      g.stealPending = true;
      g.extraTurn = true;
      g.message = `${room.players[playerIdx].name} played a Magic Bean! Steal a tile.`;
      g.messageType = 'magicBean';
      room.players.forEach((p) => {
        if (p.socket) {
          p.socket.emit('stealPhase', {
            beanstalks: g.beanstalks,
            currentPlayer: g.currentPlayer,
          });
        }
      });
      sendGameState(room);
      return; // Wait for steal or skip
    } else {
      // No stealable tiles, just extra turn
      g.extraTurn = true;
      g.message = `${room.players[playerIdx].name} played a Magic Bean! Extra turn.`;
      g.messageType = 'magicBean';
    }
  }

  // 6 Chain rule: if top is 6 and player has another tile with 6, they play again
  if (top === 6 && g.hands[playerIdx].some(t => t[0] === 6 || t[1] === 6)) {
    g.sixChain = true;
    g.message = `6 Chain! ${room.players[playerIdx].name} plays again.`;
    g.messageType = 'sixChain';
    g.drawnThisTurn = false;
    sendGameState(room);
    return;
  }

  // Reset beaned out for this player since they just played
  g.beanedOut[playerIdx] = false;

  if (g.extraTurn) {
    g.extraTurn = false;
    g.drawnThisTurn = false;
    sendGameState(room);
    return;
  }

  advanceTurn(room);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerIdx = -1;

  socket.on('createRoom', ({ playerName, numPlayers, tilesPerPlayer }) => {
    numPlayers = parseInt(numPlayers, 10);
    tilesPerPlayer = parseInt(tilesPerPlayer, 10);

    if (numPlayers < 2 || numPlayers > 4) {
      return socket.emit('error', { message: 'Number of players must be 2-4.' });
    }
    if (![3, 5, 7, 9].includes(tilesPerPlayer)) {
      return socket.emit('error', { message: 'Tiles per player must be 3, 5, 7, or 9.' });
    }
    // Validate total tiles needed doesn't exceed 28
    if (numPlayers * tilesPerPlayer > 28) {
      return socket.emit('error', { message: 'Too many tiles requested for this player count.' });
    }
    if (!playerName || !playerName.trim()) {
      return socket.emit('error', { message: 'Player name is required.' });
    }

    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    const room = {
      code,
      numPlayers,
      tilesPerPlayer,
      players: [{ name: playerName.trim(), socket }],
      game: null,
    };
    rooms[code] = room;
    currentRoom = code;
    playerIdx = 0;
    socket.join(code);

    socket.emit('roomCreated', { roomCode: code });
    socket.emit('playerJoined', {
      players: room.players.map(p => p.name),
      playerIdx: 0,
    });
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms[code];

    if (!room) {
      return socket.emit('error', { message: 'Room not found.' });
    }
    if (room.game) {
      return socket.emit('error', { message: 'Game already in progress.' });
    }
    if (room.players.length >= room.numPlayers) {
      return socket.emit('error', { message: 'Room is full.' });
    }
    if (!playerName || !playerName.trim()) {
      return socket.emit('error', { message: 'Player name is required.' });
    }

    playerIdx = room.players.length;
    room.players.push({ name: playerName.trim(), socket });
    currentRoom = code;
    socket.join(code);

    // Notify all players in room
    room.players.forEach((p, idx) => {
      if (p.socket) {
        p.socket.emit('playerJoined', {
          players: room.players.map(pl => pl.name),
          playerIdx: idx,
        });
      }
    });

    // Start game if room is full
    if (room.players.length === room.numPlayers) {
      room.game = createGameState(room.numPlayers, room.tilesPerPlayer);
      const g = room.game;
      room.players.forEach((p, idx) => {
        if (p.socket) {
          p.socket.emit('gameStart', {
            yourHand: g.hands[idx],
            beanstalks: g.beanstalks,
            currentPlayer: g.currentPlayer,
            pileCount: g.pile.length,
            players: room.players.map(pl => pl.name),
            yourIdx: idx,
          });
        }
      });
    }
  });

  socket.on('chooseOrientation', ({ tileIdx, oriented }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return socket.emit('error', { message: 'No active game.' });
    const g = room.game;

    if (g.currentPlayer !== playerIdx) {
      return socket.emit('error', { message: 'Not your turn.' });
    }
    if (g.beanstalks[playerIdx].length !== 0) {
      return socket.emit('error', { message: 'Orientation choice is only for the first tile.' });
    }
    if (tileIdx < 0 || tileIdx >= g.hands[playerIdx].length) {
      return socket.emit('error', { message: 'Invalid tile index.' });
    }

    const tile = g.hands[playerIdx][tileIdx];
    // Validate oriented matches the tile
    if (!oriented || oriented.length !== 2) {
      return socket.emit('error', { message: 'Invalid orientation.' });
    }
    const sortedOrig = [tile[0], tile[1]].sort().join(',');
    const sortedOriented = [oriented[0], oriented[1]].sort().join(',');
    if (sortedOrig !== sortedOriented) {
      return socket.emit('error', { message: 'Oriented tile does not match selected tile.' });
    }

    g.hands[playerIdx].splice(tileIdx, 1);
    g.beanstalks[playerIdx].push([oriented[0], oriented[1]]);
    g.phase = 'playing';

    handlePostPlay(room, playerIdx);
  });

  socket.on('playTile', ({ tileIdx, oriented }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return socket.emit('error', { message: 'No active game.' });
    const g = room.game;

    if (g.phase === 'steal') {
      return socket.emit('error', { message: 'Steal phase active. Steal or skip first.' });
    }
    if (g.phase === 'over') {
      return socket.emit('error', { message: 'Game is over.' });
    }
    if (g.currentPlayer !== playerIdx) {
      return socket.emit('error', { message: 'Not your turn.' });
    }
    if (tileIdx < 0 || tileIdx >= g.hands[playerIdx].length) {
      return socket.emit('error', { message: 'Invalid tile index.' });
    }

    const tile = g.hands[playerIdx][tileIdx];
    const beanstalk = g.beanstalks[playerIdx];

    // First tile — need orientation choice
    if (beanstalk.length === 0) {
      // If tile is a double, no orientation needed
      if (isDouble(tile)) {
        g.hands[playerIdx].splice(tileIdx, 1);
        g.beanstalks[playerIdx].push([tile[0], tile[1]]);
        handlePostPlay(room, playerIdx);
        return;
      }
      // Ask client for orientation
      g.phase = 'orientation';
      socket.emit('orientationNeeded', { tile, tileIdx });
      return;
    }

    const top = beanstalkTop(beanstalk);

    // 6 chain: if sixChain active, tile must have a 6
    if (g.sixChain) {
      if (tile[0] !== 6 && tile[1] !== 6) {
        return socket.emit('error', { message: '6 Chain: you must play a tile with a 6.' });
      }
      if (!canPlayOn(tile, top)) {
        return socket.emit('error', { message: 'Tile does not match the top of your beanstalk.' });
      }
    } else {
      if (!canPlayOn(tile, top)) {
        return socket.emit('error', { message: 'Tile does not match the top of your beanstalk.' });
      }
    }

    // Auto-orient
    const orientedTile = orientTile(tile, top);
    if (!orientedTile) {
      return socket.emit('error', { message: 'Cannot orient tile to match.' });
    }

    // Validate if client sent oriented — must match auto-orient
    // (we trust server orientation regardless)

    g.hands[playerIdx].splice(tileIdx, 1);
    g.beanstalks[playerIdx].push(orientedTile);
    g.sixChain = false;

    handlePostPlay(room, playerIdx);
  });

  socket.on('drawTile', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return socket.emit('error', { message: 'No active game.' });
    const g = room.game;

    if (g.currentPlayer !== playerIdx) {
      return socket.emit('error', { message: 'Not your turn.' });
    }
    if (g.phase === 'steal') {
      return socket.emit('error', { message: 'Steal phase active.' });
    }
    if (g.drawnThisTurn) {
      return socket.emit('error', { message: 'Already drew this turn.' });
    }
    if (g.pile.length === 0) {
      return socket.emit('error', { message: 'Pile is empty.' });
    }

    // Player should only draw if they can't play
    const top = beanstalkTop(g.beanstalks[playerIdx]);
    if (top !== null && playerHasPlay(g.hands[playerIdx], top)) {
      return socket.emit('error', { message: 'You have a playable tile. Play it instead.' });
    }

    const drawn = g.pile.pop();
    g.hands[playerIdx].push(drawn);
    g.drawnThisTurn = true;

    // If drawn tile matches, player can play it (same turn) — just update state
    // The client will see the new hand and can play the drawn tile
    if (top === null || canPlayOn(drawn, top)) {
      g.message = `${room.players[playerIdx].name} drew a tile and can play it!`;
      g.messageType = 'draw';
      sendGameState(room);
      return;
    }

    // Drawn tile doesn't match — turn passes
    g.message = `${room.players[playerIdx].name} drew a tile but can't play.`;
    g.messageType = 'draw';
    sendGameState(room);

    // Small delay then advance
    setTimeout(() => advanceTurn(room), 500);
  });

  socket.on('passTurn', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return socket.emit('error', { message: 'No active game.' });
    const g = room.game;

    if (g.currentPlayer !== playerIdx) {
      return socket.emit('error', { message: 'Not your turn.' });
    }

    const top = beanstalkTop(g.beanstalks[playerIdx]);

    // Can only pass if pile is empty and no playable tiles
    if (g.pile.length > 0 && !g.drawnThisTurn) {
      return socket.emit('error', { message: 'You must draw from the pile first.' });
    }
    if (top !== null && playerHasPlay(g.hands[playerIdx], top)) {
      return socket.emit('error', { message: 'You have a playable tile.' });
    }

    g.beanedOut[playerIdx] = true;
    g.message = `${room.players[playerIdx].name} is beaned out!`;
    g.messageType = 'beanedOut';

    advanceTurn(room);
  });

  socket.on('stealTile', ({ fromPlayer, tileIdx }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return socket.emit('error', { message: 'No active game.' });
    const g = room.game;

    if (g.currentPlayer !== playerIdx) {
      return socket.emit('error', { message: 'Not your turn.' });
    }
    if (g.phase !== 'steal' || !g.stealPending) {
      return socket.emit('error', { message: 'Not in steal phase.' });
    }
    if (fromPlayer === playerIdx) {
      return socket.emit('error', { message: 'Cannot steal from yourself.' });
    }
    if (fromPlayer < 0 || fromPlayer >= room.numPlayers) {
      return socket.emit('error', { message: 'Invalid player.' });
    }

    const targetBeanstalk = g.beanstalks[fromPlayer];
    if (tileIdx < 0 || tileIdx >= targetBeanstalk.length) {
      return socket.emit('error', { message: 'Invalid tile index.' });
    }

    const tile = targetBeanstalk[tileIdx];
    if (isDouble(tile)) {
      return socket.emit('error', { message: 'Cannot steal Magic Beans (doubles).' });
    }

    // Remove from opponent's beanstalk, add to stealer's hand
    targetBeanstalk.splice(tileIdx, 1);
    g.hands[playerIdx].push(tile);

    g.phase = 'playing';
    g.stealPending = false;
    g.message = `${room.players[playerIdx].name} stole a tile from ${room.players[fromPlayer].name}!`;
    g.messageType = 'steal';

    // Extra turn from magic bean — check 6 chain first
    const top = beanstalkTop(g.beanstalks[playerIdx]);
    if (top === 6 && g.hands[playerIdx].some(t => t[0] === 6 || t[1] === 6)) {
      g.sixChain = true;
      g.extraTurn = false;
      g.message = `6 Chain! ${room.players[playerIdx].name} plays again.`;
      g.messageType = 'sixChain';
      g.drawnThisTurn = false;
      sendGameState(room);
      return;
    }

    // Extra turn
    g.drawnThisTurn = false;
    sendGameState(room);
  });

  socket.on('skipSteal', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return socket.emit('error', { message: 'No active game.' });
    const g = room.game;

    if (g.currentPlayer !== playerIdx) {
      return socket.emit('error', { message: 'Not your turn.' });
    }
    if (g.phase !== 'steal' || !g.stealPending) {
      return socket.emit('error', { message: 'Not in steal phase.' });
    }

    g.phase = 'playing';
    g.stealPending = false;
    g.message = `${room.players[playerIdx].name} skipped stealing.`;
    g.messageType = 'info';

    // Still gets extra turn from magic bean
    const top = beanstalkTop(g.beanstalks[playerIdx]);
    if (top === 6 && g.hands[playerIdx].some(t => t[0] === 6 || t[1] === 6)) {
      g.sixChain = true;
      g.extraTurn = false;
      g.message = `6 Chain! ${room.players[playerIdx].name} plays again.`;
      g.messageType = 'sixChain';
    }

    g.drawnThisTurn = false;
    sendGameState(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;

    const p = room.players[playerIdx];
    if (p) p.socket = null;

    // If game hasn't started and creator leaves, destroy room
    if (!room.game) {
      delete rooms[currentRoom];
      // Notify remaining players
      room.players.forEach((pl) => {
        if (pl.socket) {
          pl.socket.emit('error', { message: 'Room creator left. Room closed.' });
        }
      });
    } else {
      // Notify others
      room.players.forEach((pl) => {
        if (pl.socket) {
          pl.socket.emit('gameState', {
            message: `${room.players[playerIdx].name} disconnected.`,
            messageType: 'error',
            phase: room.game.phase,
            beanstalks: room.game.beanstalks,
            currentPlayer: room.game.currentPlayer,
            pileCount: room.game.pile.length,
            players: room.players.map(x => x.name),
            scores: getScores(room),
            beanedOut: room.game.beanedOut,
          });
        }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Magic Beans server running on port ${PORT}`);
});
