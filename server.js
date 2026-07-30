import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const httpServer = createServer(app)

const PORT = Number(process.env.PORT ?? 3001)
const ROOM_TTL_MS = 1000 * 60 * 60 * 24
const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim() || '*'
const allowedOrigins =
  CORS_ORIGIN === '*'
    ? true
    : CORS_ORIGIN.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
})

/**
 * @typedef {{
 * id: string
 * displayName: string
 * joinedAt: number
 * }} Participant
 *
 * @typedef {{
 * roomId: string
 * roomLink: string
 * mode: 'embed' | 'share'
 * embedStatus: 'idle' | 'loading' | 'ready' | 'blocked'
 * participants: Participant[]
 * hostSocketId: string | null
 * createdAt: number
 * updatedAt: number
 * messages: { id: string, displayName: string, text: string, sentAt: number }[]
 * lastReaction: { emoji: string, displayName: string, sentAt: number } | null
 * playbackState?: { isPlaying: boolean, positionSec: number, updatedAt: number }
 * sharePaused?: boolean
 * }} RoomState
 */

/** @type {Map<string, RoomState>} */
const rooms = new Map()

app.use(
  cors({
    origin: allowedOrigins,
  }),
)
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bella-stream',
    rooms: rooms.size,
    time: Date.now(),
  })
})

app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId)

  if (!room) {
    res.status(404).json({ error: 'Room not found' })
    return
  }

  res.json(serializeRoom(room))
})

function createRoomState(roomId) {
  const now = Date.now()

  return {
    roomId,
    roomLink: '',
    mode: 'embed',
    embedStatus: 'idle',
    participants: [],
    hostSocketId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
    lastReaction: null,
    playbackState: {
      isPlaying: false,
      positionSec: 0,
      updatedAt: now,
    },
    sharePaused: false,
  }
}

function ensureRoom(roomId) {
  const existing = rooms.get(roomId)

  if (existing) {
    return existing
  }

  const room = createRoomState(roomId)
  rooms.set(roomId, room)
  return room
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    roomLink: room.roomLink,
    mode: room.mode,
    embedStatus: room.embedStatus,
    participants: room.participants,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    hostSocketId: room.hostSocketId,
    messages: room.messages.slice(-50),
    lastReaction: room.lastReaction,
    playbackState: room.playbackState,
    sharePaused: room.sharePaused ?? false,
  }
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId)

  if (!room) {
    return
  }

  room.updatedAt = Date.now()
  io.to(roomId).emit('room-state', serializeRoom(room))
}

function randomId() {
  return Math.random().toString(36).slice(2, 8)
}

function sweepInactiveRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS

  for (const [roomId, room] of rooms.entries()) {
    if (room.updatedAt < cutoff && room.participants.length === 0) {
      rooms.delete(roomId)
    }
  }
}

setInterval(sweepInactiveRooms, 1000 * 60 * 30).unref()

io.on('connection', (socket) => {
  socket.on('create-room', ({ displayName }, callback) => {
    const roomId = randomId()
    const room = ensureRoom(roomId)
    room.roomLink = ''

    callback?.({
      roomId,
      displayName,
    })
  })

  socket.on('join-room', ({ roomId, displayName, roomLink }, callback) => {
    if (!roomId || !displayName) {
      callback?.({ ok: false, message: 'Room and name are required.' })
      return
    }

    const room = rooms.get(roomId)
    if (!room) {
      callback?.({
        ok: false,
        message: 'Room not found or server restarted. Ask the host to create a new room.',
      })
      return
    }

    room.roomLink = roomLink ?? room.roomLink

    socket.join(roomId)
    socket.data.roomId = roomId
    socket.data.displayName = displayName

    room.participants = room.participants.filter((participant) => participant.id !== socket.id)
    room.participants.push({
      id: socket.id,
      displayName,
      joinedAt: Date.now(),
    })

    if (!room.hostSocketId) {
      room.hostSocketId = socket.id
    }

    broadcastRoom(roomId)
    io.to(roomId).emit('presence', {
      type: 'joined',
      displayName,
      socketId: socket.id,
      participantCount: room.participants.length,
    })

    if (room.participants.length >= 2) {
      io.to(roomId).emit('renegotiate', {
        reason: 'peer-joined',
        participantCount: room.participants.length,
      })
    }

    callback?.({
      ok: true,
      room: serializeRoom(room),
      isHost: room.hostSocketId === socket.id,
    })
  })

  socket.on('set-room-link', ({ roomId, roomLink }) => {
    const room = rooms.get(roomId)

    if (!room) {
      return
    }

    room.roomLink = roomLink
    room.mode = 'embed'
    room.embedStatus = 'loading'
    room.playbackState = {
      isPlaying: false,
      positionSec: 0,
      updatedAt: Date.now(),
    }
    broadcastRoom(roomId)
  })

  socket.on('playback-event', ({ roomId, type, positionSec }) => {
    const room = rooms.get(roomId)

    if (!room || !['play', 'pause', 'seek'].includes(type)) {
      return
    }

    const position = Number(positionSec)
    room.playbackState = {
      isPlaying: type === 'play' ? true : type === 'pause' ? false : room.playbackState?.isPlaying ?? false,
      positionSec: Number.isFinite(position) ? position : room.playbackState?.positionSec ?? 0,
      updatedAt: Date.now(),
    }

    socket.to(roomId).emit('playback-sync', {
      type,
      positionSec: room.playbackState.positionSec,
      isPlaying: room.playbackState.isPlaying,
      updatedAt: room.playbackState.updatedAt,
      fromSocketId: socket.id,
    })
    broadcastRoom(roomId)
  })

  socket.on('playback-request', ({ roomId }) => {
    const room = rooms.get(roomId)

    if (!room?.playbackState) {
      return
    }

    socket.emit('playback-sync', {
      type: room.playbackState.isPlaying ? 'play' : 'pause',
      positionSec: room.playbackState.positionSec,
      isPlaying: room.playbackState.isPlaying,
      updatedAt: room.playbackState.updatedAt,
      fromSocketId: null,
    })
  })

  socket.on('share-control', ({ roomId, action }) => {
    const room = rooms.get(roomId)

    if (!room || (action !== 'play' && action !== 'pause')) {
      return
    }

    room.sharePaused = action === 'pause'
    io.to(roomId).emit('share-control', {
      action,
      sharePaused: room.sharePaused,
      displayName: socket.data.displayName ?? 'Guest',
      fromSocketId: socket.id,
    })
    broadcastRoom(roomId)
  })

  socket.on('watch-cue', ({ roomId, action, at }) => {
    if (!roomId || !['play', 'pause', 'countdown'].includes(action)) {
      return
    }

    const room = rooms.get(roomId)
    if (!room) {
      return
    }

    socket.to(roomId).emit('watch-cue', {
      action,
      at: Number(at) || Date.now() + 3000,
      fromSocketId: socket.id,
      displayName: socket.data.displayName ?? 'Guest',
    })
  })

  socket.on('set-mode', ({ roomId, mode }) => {
    const room = rooms.get(roomId)

    if (!room || (mode !== 'embed' && mode !== 'share')) {
      return
    }

    room.mode = mode
    broadcastRoom(roomId)
  })

  socket.on('set-embed-status', ({ roomId, status }) => {
    const room = rooms.get(roomId)

    if (!room) {
      return
    }

    room.embedStatus = status
    broadcastRoom(roomId)
  })

  socket.on('chat-message', ({ roomId, text }) => {
    const room = rooms.get(roomId)

    if (!room || !text) {
      return
    }

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: socket.data.displayName ?? 'Guest',
      text: String(text).slice(0, 400),
      sentAt: Date.now(),
    }

    room.messages.push(message)
    room.messages = room.messages.slice(-50)
    io.to(roomId).emit('chat-message', message)
    broadcastRoom(roomId)
  })

  socket.on('reaction', ({ roomId, emoji }) => {
    const room = rooms.get(roomId)

    if (!room || !emoji) {
      return
    }

    room.lastReaction = {
      emoji: String(emoji).slice(0, 8),
      displayName: socket.data.displayName ?? 'Guest',
      sentAt: Date.now(),
    }

    io.to(roomId).emit('reaction', room.lastReaction)
  })

  socket.on('signal', ({ roomId, payload, targetSocketId }) => {
    if (!roomId || !payload) {
      return
    }

    if (targetSocketId) {
      io.to(targetSocketId).emit('signal', {
        fromSocketId: socket.id,
        payload,
      })
      return
    }

    socket.to(roomId).emit('signal', {
      fromSocketId: socket.id,
      payload,
    })
  })

  socket.on('request-media-sync', ({ roomId }) => {
    if (!roomId) {
      return
    }

    socket.to(roomId).emit('request-media-sync', {
      fromSocketId: socket.id,
    })
  })

  socket.on('media-stopped', ({ roomId, kind }) => {
    if (!roomId) {
      return
    }

    socket.to(roomId).emit('media-stopped', {
      kind: kind ?? 'all',
      displayName: socket.data.displayName ?? 'Guest',
      fromSocketId: socket.id,
    })
  })

  socket.on('theater-fullscreen', ({ roomId, active }) => {
    if (!roomId) {
      return
    }

    socket.to(roomId).emit('theater-fullscreen', {
      active: Boolean(active),
      displayName: socket.data.displayName ?? 'Guest',
      fromSocketId: socket.id,
    })
  })

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId

    if (!roomId) {
      return
    }

    const room = rooms.get(roomId)

    if (!room) {
      return
    }

    room.participants = room.participants.filter((participant) => participant.id !== socket.id)

    if (room.hostSocketId === socket.id) {
      room.hostSocketId = room.participants[0]?.id ?? null
    }

    io.to(roomId).emit('presence', {
      type: 'left',
      displayName: socket.data.displayName ?? 'Guest',
    })

    broadcastRoom(roomId)
  })
})

// Serve the Vite build when this Node host is used as the full app (optional).
const distPath = path.join(__dirname, 'dist')
app.use(express.static(distPath))
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next()
    return
  }

  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    next()
    return
  }

  res.sendFile(path.join(distPath, 'index.html'), (error) => {
    if (error) {
      next()
    }
  })
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Bella Stream server listening on http://0.0.0.0:${PORT}`)
})
