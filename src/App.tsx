import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'
import { SyncedHtmlVideo } from './SyncedHtmlVideo'
import { SyncedYouTubePlayer, type SyncPayload } from './SyncedYouTubePlayer'

type Mode = 'embed' | 'share'
type EmbedStatus = 'idle' | 'loading' | 'ready' | 'blocked'

type Participant = {
  id: string
  displayName: string
  joinedAt: number
}

type ChatMessage = {
  id: string
  displayName: string
  text: string
  sentAt: number
}

type ReactionPayload = {
  emoji: string
  displayName: string
  sentAt: number
}

type RoomState = {
  roomId: string
  roomLink: string
  mode: Mode
  embedStatus: EmbedStatus
  participants: Participant[]
  createdAt: number
  updatedAt: number
  hostSocketId: string | null
  messages: ChatMessage[]
  lastReaction: ReactionPayload | null
  playbackState?: {
    isPlaying: boolean
    positionSec: number
    updatedAt: number
  }
  sharePaused?: boolean
}

type SignalPayload = {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  displayStreamIds?: string[]
  cameraStreamIds?: string[]
}

const SOCKET_FROM_ENV = String(import.meta.env.VITE_SOCKET_URL ?? '')
  .trim()
  .replace(/\/$/, '')

const SERVER_URL = (() => {
  if (SOCKET_FROM_ENV) {
    return SOCKET_FROM_ENV
  }

  const host = window.location.hostname
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3001'
  }

  // Same-origin when the Node server also serves the built client.
  return window.location.origin
})()

const NEEDS_SOCKET_SETUP =
  !SOCKET_FROM_ENV &&
  typeof window !== 'undefined' &&
  /netlify\.app$/i.test(window.location.hostname)

const iceServers: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  // Public TURN fallbacks for cross-network camera/mic (best effort).
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:80?transport=tcp',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

const isSecureContext =
  window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function' && !/iPhone|iPad|iPod/i.test(navigator.userAgent)

function detectDirectVideo(link: string) {
  return /\.(mp4|webm|ogg)(\?.*)?$/i.test(link)
}

function extractYouTubeId(link: string) {
  try {
    const url = new URL(link)

    if (url.hostname.includes('youtu.be')) {
      return url.pathname.split('/').filter(Boolean)[0] ?? null
    }

    if (url.hostname.includes('youtube.com') || url.hostname.includes('youtube-nocookie.com')) {
      if (url.pathname.startsWith('/embed/')) {
        return url.pathname.split('/')[2] ?? null
      }

      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/')[2] ?? null
      }

      if (url.pathname.startsWith('/live/')) {
        return url.pathname.split('/')[2] ?? null
      }

      return url.searchParams.get('v')
    }
  } catch {
    return null
  }

  return null
}

function extractVimeoId(link: string) {
  try {
    const url = new URL(link)

    if (!url.hostname.includes('vimeo.com')) {
      return null
    }

    if (url.hostname.startsWith('player.')) {
      const parts = url.pathname.split('/').filter(Boolean)
      return parts[parts.length - 1] ?? null
    }

    const match = url.pathname.match(/\/(?:video\/)?(\d+)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** Convert pasted links into iframe-friendly embed URLs when possible. */
function toEmbeddableUrl(link: string) {
  const trimmed = link.trim()

  if (!trimmed) {
    return trimmed
  }

  const youtubeId = extractYouTubeId(trimmed)
  if (youtubeId) {
    return `https://www.youtube.com/embed/${youtubeId}?autoplay=1&rel=0`
  }

  const vimeoId = extractVimeoId(trimmed)
  if (vimeoId) {
    return `https://player.vimeo.com/video/${vimeoId}?autoplay=1`
  }

  return trimmed
}

function shortTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

function updateRoomParam(roomId: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('room', roomId)
  window.history.replaceState({}, '', url)
}

function App() {
  const [socketConnected, setSocketConnected] = useState(false)
  const [displayName, setDisplayName] = useState(localStorage.getItem('bella-name') ?? '')
  const [pendingRoomId, setPendingRoomId] = useState(
    new URLSearchParams(window.location.search).get('room') ?? '',
  )
  const [joinedRoomId, setJoinedRoomId] = useState('')
  const [roomLinkInput, setRoomLinkInput] = useState(localStorage.getItem('bella-last-link') ?? '')
  const [draftMessage, setDraftMessage] = useState('')
  const urlHasRoom = Boolean(new URLSearchParams(window.location.search).get('room'))
  const [statusMessage, setStatusMessage] = useState(
    !isSecureContext
      ? 'Warning: not a secure context (HTTPS). Screen share and camera will not work.'
      : urlHasRoom
        ? 'Enter your name and click Join room to connect.'
        : 'Create a private room to start watching together.',
  )
  const [roomState, setRoomState] = useState<RoomState | null>(null)
  const [reactions, setReactions] = useState<ReactionPayload[]>([])
  const [isHost, setIsHost] = useState(false)
  const [peerStatus, setPeerStatus] = useState('No live share yet')
  const [embedLoaded, setEmbedLoaded] = useState(false)
  const [sharingDisplay, setSharingDisplay] = useState(false)
  const [callEnabled, setCallEnabled] = useState(false)
  const [isTheaterFullscreen, setIsTheaterFullscreen] = useState(false)
  const [sharePaused, setSharePaused] = useState(false)
  const [cueText, setCueText] = useState('')
  const [remoteDisplayStream, setRemoteDisplayStream] = useState<MediaStream | null>(null)
  const [remoteCameraStream, setRemoteCameraStream] = useState<MediaStream | null>(null)
  const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null)
  const [localCameraPreview, setLocalCameraPreview] = useState<MediaStream | null>(null)
  const [audioBlocked, setAudioBlocked] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const displayStreamRef = useRef<MediaStream | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const theaterFrameRef = useRef<HTMLDivElement | null>(null)
  const remoteDisplayVideoRef = useRef<HTMLVideoElement | null>(null)
  const localDisplayVideoRef = useRef<HTMLVideoElement | null>(null)
  const localCameraRef = useRef<HTMLVideoElement | null>(null)
  const remoteCameraRef = useRef<HTMLVideoElement | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const fallbackTimerRef = useRef<number | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const activeRoomRef = useRef('')
  const displayNameRef = useRef(displayName)
  const roomLinkInputRef = useRef(roomLinkInput)
  const isHostRef = useRef(false)
  const hasReceivedDisplayRef = useRef(false)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const makingOfferRef = useRef(false)
  const ignoreOfferRef = useRef(false)
  const politeRef = useRef(true)
  const remoteDisplayStreamIdsRef = useRef<Set<string>>(new Set())
  const remoteCameraStreamIdsRef = useRef<Set<string>>(new Set())
  const syncChainRef = useRef(Promise.resolve())
  const syncQueuedRef = useRef(false)
  const applyPlaybackSyncRef = useRef<((payload: SyncPayload) => void) | null>(null)
  const applyShareControlRef = useRef<((action: 'play' | 'pause', actorName?: string) => void) | null>(
    null,
  )
  const applyWatchCueRef = useRef<
    ((action: 'play' | 'pause' | 'countdown', at?: number, actorName?: string) => void) | null
  >(null)

  const activeRoom = roomState?.roomId ?? joinedRoomId
  const inviteLink = useMemo(() => {
    if (!activeRoom) {
      return ''
    }

    const url = new URL(window.location.href)
    url.searchParams.set('room', activeRoom)
    return url.toString()
  }, [activeRoom])

  const sortedMessages = roomState?.messages ?? []
  const activeLink = roomState?.roomLink ?? roomLinkInput
  const canUseDirectVideo = detectDirectVideo(activeLink)
  const youtubeId = extractYouTubeId(activeLink)
  const embedUrl = toEmbeddableUrl(activeLink)
  const isKnownEmbedProvider = Boolean(youtubeId || extractVimeoId(activeLink))
  const canSyncPlayback = Boolean(youtubeId || canUseDirectVideo)
  const inputCanSync = Boolean(
    extractYouTubeId(roomLinkInput.trim()) || detectDirectVideo(roomLinkInput.trim()),
  )
  const isGenericSiteEmbed = Boolean(roomState?.roomLink && !canSyncPlayback && roomState.mode === 'embed')
  const hostParticipant = roomState?.participants.find((p) => p.id === roomState.hostSocketId)

  const emitPlayback = useCallback((type: 'play' | 'pause' | 'seek', positionSec: number) => {
    if (!activeRoomRef.current) {
      return
    }

    socketRef.current?.emit('playback-event', {
      roomId: activeRoomRef.current,
      type,
      positionSec,
    })
  }, [])

  const registerApplySync = useCallback((fn: ((payload: SyncPayload) => void) | null) => {
    applyPlaybackSyncRef.current = fn
  }, [])

  useEffect(() => {
    activeRoomRef.current = activeRoom
  }, [activeRoom])

  useEffect(() => {
    displayNameRef.current = displayName
  }, [displayName])

  useEffect(() => {
    roomLinkInputRef.current = roomLinkInput
  }, [roomLinkInput])

  useEffect(() => {
    if (!roomState || !socketRef.current?.id) {
      return
    }

    const host = roomState.hostSocketId === socketRef.current.id
    setIsHost(host)
    isHostRef.current = host
  }, [roomState])

  function persistSession(nextRoomId: string, nextLink?: string) {
    localStorage.setItem('bella-name', displayNameRef.current)
    localStorage.setItem(
      'bella-recent-session',
      JSON.stringify({
        roomId: nextRoomId,
        roomLink: nextLink ?? roomLinkInputRef.current,
        savedAt: Date.now(),
      }),
    )

    if (nextLink) {
      localStorage.setItem('bella-last-link', nextLink)
    }
  }

  function destroyPeer() {
    if (peerRef.current) {
      peerRef.current.onicecandidate = null
      peerRef.current.ontrack = null
      peerRef.current.onconnectionstatechange = null
      peerRef.current.onnegotiationneeded = null
      peerRef.current.close()
      peerRef.current = null
    }

    hasReceivedDisplayRef.current = false
    pendingIceRef.current = []
    remoteDisplayStreamIdsRef.current.clear()
    remoteCameraStreamIdsRef.current.clear()
    makingOfferRef.current = false
    ignoreOfferRef.current = false
    setPeerStatus('No live share yet')
    setRemoteDisplayStream(null)
    setRemoteCameraStream(null)
    setRemoteAudioStream(null)
  }

  function forceRenegotiateAsOfferer(reason = 'manual', hardReset = false) {
    if (!activeRoomRef.current) {
      return
    }

    // Soft path: keep the existing peer alive whenever possible.
    if (
      hardReset ||
      peerRef.current?.connectionState === 'failed' ||
      peerRef.current?.connectionState === 'closed'
    ) {
      destroyPeer()
    }

    const peer = getOrCreatePeer()

    if (displayStreamRef.current) {
      attachLocalTracks(peer, displayStreamRef.current, 'display')
    }
    if (cameraStreamRef.current) {
      attachLocalTracks(peer, cameraStreamRef.current, 'camera')
    }

    setPeerStatus(`Syncing (${reason})`)

    // Either side may offer (perfect negotiation). Also nudge the partner.
    void syncOfferNow(true)
    requestMediaSync()
  }

  function preferVideoCodecs(peer: RTCPeerConnection) {
    try {
      const capabilities = RTCRtpSender.getCapabilities?.('video')
      if (!capabilities?.codecs?.length) {
        return
      }

      const preferred = [...capabilities.codecs].sort((a, b) => {
        const rank = (codec: { mimeType: string }) => {
          const mime = codec.mimeType.toLowerCase()
          if (mime.includes('vp9')) return 0
          if (mime.includes('h264')) return 1
          if (mime.includes('vp8')) return 2
          return 3
        }
        return rank(a) - rank(b)
      })

      for (const transceiver of peer.getTransceivers()) {
        if (transceiver.sender.track?.kind === 'video' || transceiver.receiver.track?.kind === 'video') {
          transceiver.setCodecPreferences?.(preferred)
        }
      }
    } catch {
      // Codec preference is best-effort.
    }
  }

  function routeRemoteVideoTrack(track: MediaStreamTrack, streams: readonly MediaStream[]) {
    track.enabled = true
    const nextStream = new MediaStream([track])
    const streamId = streams[0]?.id ?? ''
    const label = track.label.toLowerCase()

    const markedDisplay = Boolean(streamId && remoteDisplayStreamIdsRef.current.has(streamId))
    const markedCamera = Boolean(streamId && remoteCameraStreamIdsRef.current.has(streamId))
    const looksLikeDisplay =
      label.includes('screen') ||
      label.includes('window') ||
      label.includes('tab') ||
      label.includes('monitor') ||
      label.includes('display') ||
      label.includes('web-contents')

    // Only route to the main theater when this is clearly a screen/tab share.
    if (!markedCamera && (markedDisplay || looksLikeDisplay)) {
      hasReceivedDisplayRef.current = true
      setRemoteDisplayStream(nextStream)
      socketRef.current?.emit('set-mode', {
        roomId: activeRoomRef.current,
        mode: 'share',
      })
      return
    }

    setRemoteCameraStream(nextStream)
    setStatusMessage('Partner camera connected.')
  }

  async function flushPendingIce(peer: RTCPeerConnection) {
    if (!peer.remoteDescription) {
      return
    }

    const queued = pendingIceRef.current.splice(0)
    for (const candidate of queued) {
      try {
        await peer.addIceCandidate(candidate)
      } catch {
        // Ignore stale candidates after renegotiation.
      }
    }
  }

  const getOrCreatePeer = useCallback(() => {
    if (peerRef.current) {
      const state = peerRef.current.connectionState

      if (state === 'failed' || state === 'closed') {
        destroyPeer()
      } else {
        return peerRef.current
      }
    }

    const peer = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 8,
    })

    peer.onconnectionstatechange = () => {
      setPeerStatus(peer.connectionState)

      if (peer.connectionState === 'connected') {
        setStatusMessage('Live peer connected.')
        void optimizePeerSenders(peer)
      }

      if (peer.connectionState === 'failed') {
        setStatusMessage('Peer connection failed. Retrying sync...')
        destroyPeer()
        window.setTimeout(() => {
          if (displayStreamRef.current || cameraStreamRef.current) {
            forceRenegotiateAsOfferer('peer-failed', true)
          } else {
            requestMediaSync()
          }
        }, 700)
      }
    }

    peer.onicecandidate = (event) => {
      if (!event.candidate || !activeRoomRef.current) {
        return
      }

      socketRef.current?.emit('signal', {
        roomId: activeRoomRef.current,
        payload: { candidate: event.candidate.toJSON() },
      })
    }

    peer.ontrack = (event) => {
      event.track.enabled = true

      if (event.track.kind === 'video') {
        routeRemoteVideoTrack(event.track, event.streams)
        event.track.onended = () => {
          setRemoteDisplayStream((current) => {
            if (current?.getVideoTracks()[0]?.id === event.track.id) {
              hasReceivedDisplayRef.current = false
              return null
            }
            return current
          })

          setRemoteCameraStream((current) => {
            if (current?.getVideoTracks()[0]?.id === event.track.id) {
              return null
            }
            return current
          })
        }
      }

      if (event.track.kind === 'audio') {
        setRemoteAudioStream((current) => {
          const nextAudio = new MediaStream(current?.getTracks() ?? [])
          if (!nextAudio.getTracks().some((t) => t.id === event.track.id)) {
            nextAudio.addTrack(event.track)
          }
          return nextAudio
        })
      }
    }

    peer.onnegotiationneeded = () => {
      // Perfect negotiation: whichever side adds tracks may create an offer.
      void syncOfferNow()
    }

    peerRef.current = peer
    return peer
  }, [])

  function syncOfferNow(force = false) {
    const roomId = activeRoomRef.current
    if (!roomId) {
      return Promise.resolve()
    }

    // Coalesce bursts into one offer so debounce never leaves dangling promises.
    if (syncQueuedRef.current && !force) {
      return syncChainRef.current
    }

    syncQueuedRef.current = true
    syncChainRef.current = syncChainRef.current
      .catch(() => undefined)
      .then(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, force ? 100 : 200))
        syncQueuedRef.current = false

        const peer = getOrCreatePeer()
        if (makingOfferRef.current) {
          if (force) {
            window.setTimeout(() => {
              void syncOfferNow(true)
            }, 300)
          }
          return
        }

        // Ready for an offer: stable + not ignoring a remote offer.
        if (peer.signalingState !== 'stable' || ignoreOfferRef.current) {
          if (force) {
            window.setTimeout(() => {
              void syncOfferNow(true)
            }, 400)
          }
          return
        }

        const activePeer = getOrCreatePeer()
        preferVideoCodecs(activePeer)

        try {
          makingOfferRef.current = true
          const offer = await activePeer.createOffer()

          // Glare / state change while creating — abort cleanly.
          if (activePeer.signalingState !== 'stable' || ignoreOfferRef.current) {
            return
          }

          await activePeer.setLocalDescription(offer)

          socketRef.current?.emit('signal', {
            roomId,
            payload: {
              description: activePeer.localDescription ?? offer,
              displayStreamIds: displayStreamRef.current ? [displayStreamRef.current.id] : [],
              cameraStreamIds: cameraStreamRef.current ? [cameraStreamRef.current.id] : [],
            },
          })
          setPeerStatus(activePeer.connectionState || 'connecting')
          void optimizePeerSenders(activePeer)
        } catch {
          setPeerStatus('Offer failed')
        } finally {
          makingOfferRef.current = false
        }
      })

    return syncChainRef.current
  }

  function attachLocalTracks(peer: RTCPeerConnection, stream: MediaStream, kind: 'display' | 'camera') {
    for (const track of stream.getTracks()) {
      track.enabled = true

      if (kind === 'camera' && 'contentHint' in track) {
        track.contentHint = track.kind === 'video' ? 'motion' : 'speech'
      }
      if (kind === 'display' && track.kind === 'video' && 'contentHint' in track) {
        track.contentHint = 'detail'
      }
      if (kind === 'display' && track.kind === 'audio' && 'contentHint' in track) {
        track.contentHint = 'music'
      }

      const alreadySending = peer.getSenders().some((sender) => sender.track?.id === track.id)
      if (!alreadySending) {
        peer.addTrack(track, stream)
      }
    }

    preferVideoCodecs(peer)
    void optimizePeerSenders(peer)
  }

  async function optimizePeerSenders(peer: RTCPeerConnection) {
    await Promise.all(
      peer.getSenders().map(async (sender) => {
        const track = sender.track
        if (!track) {
          return
        }

        try {
          const params = sender.getParameters()
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}]
          }

          const nextEncoding = { ...params.encodings[0] }
          nextEncoding.scaleResolutionDownBy = 1
          nextEncoding.priority = 'high'
          nextEncoding.networkPriority = 'high'

          if (track.kind === 'video') {
            const isDisplay = track.contentHint === 'detail'
            nextEncoding.maxBitrate = isDisplay ? 12_000_000 : 3_000_000
            nextEncoding.maxFramerate = isDisplay ? 60 : 30
            params.degradationPreference = isDisplay ? 'maintain-resolution' : 'balanced'
          }

          if (track.kind === 'audio') {
            nextEncoding.maxBitrate = track.contentHint === 'music' ? 256_000 : 160_000
            params.degradationPreference = 'maintain-framerate'
          }

          params.encodings = [nextEncoding]
          await sender.setParameters(params)
        } catch {
          // Some browsers reject sender tuning; best effort only.
        }
      }),
    )
  }

  function requestMediaSync() {
    if (!activeRoomRef.current) {
      return
    }

    socketRef.current?.emit('request-media-sync', {
      roomId: activeRoomRef.current,
    })
  }

  function pushLocalMediaIfAny(force = false) {
    const peer = getOrCreatePeer()

    if (displayStreamRef.current) {
      attachLocalTracks(peer, displayStreamRef.current, 'display')
    }

    if (cameraStreamRef.current) {
      attachLocalTracks(peer, cameraStreamRef.current, 'camera')
    }

    if (!(displayStreamRef.current || cameraStreamRef.current)) {
      return
    }

    void syncOfferNow(force)
  }

  function stopStream(stream: MediaStream | null) {
    if (!stream) {
      return
    }

    for (const track of stream.getTracks()) {
      if (peerRef.current) {
        const sender = peerRef.current
          .getSenders()
          .find((s) => s.track?.id === track.id)

        if (sender) {
          peerRef.current.removeTrack(sender)
        }
      }

      track.stop()
    }
  }

  function rejoinRoom() {
    const roomId = activeRoomRef.current
    const name = displayNameRef.current.trim()

    if (!roomId || !name || !socketRef.current?.connected) {
      return
    }

    socketRef.current.emit(
      'join-room',
      {
        roomId,
        displayName: name,
        roomLink: roomLinkInputRef.current.trim(),
      },
      (response: { ok: boolean; room?: RoomState; isHost?: boolean }) => {
        if (response.ok && response.room) {
          setRoomState(response.room)
          setIsHost(Boolean(response.isHost))
          isHostRef.current = Boolean(response.isHost)
          setStatusMessage('Reconnected and rejoined room.')
        }
      },
    )
  }

  function handleCreateRoom() {
    if (!displayName.trim()) {
      setStatusMessage('Add your name before creating a room.')
      return
    }

    socketRef.current?.emit(
      'create-room',
      { displayName: displayName.trim() },
      (response: { roomId: string }) => {
        setPendingRoomId(response.roomId)
        updateRoomParam(response.roomId)
        handleJoinRoom(response.roomId)
      },
    )
  }

  function handleJoinRoom(roomIdOverride?: string) {
    const roomId = (roomIdOverride ?? pendingRoomId).trim()

    if (!displayName.trim() || !roomId) {
      setStatusMessage('Enter your name and a room code before joining.')
      return
    }

    if (!socketRef.current?.connected) {
      setStatusMessage('Waiting for connection... try again in a moment.')
      return
    }

    socketRef.current.emit(
      'join-room',
      {
        roomId,
        displayName: displayName.trim(),
        roomLink: roomLinkInput.trim(),
      },
      (response: { ok: boolean; message?: string; room?: RoomState; isHost?: boolean }) => {
        if (!response.ok || !response.room) {
          setStatusMessage(response.message ?? 'Unable to join room.')
          return
        }

        setJoinedRoomId(roomId)
        setRoomState(response.room)
        setIsHost(Boolean(response.isHost))
        isHostRef.current = Boolean(response.isHost)
        setStatusMessage('Room connected. Paste a link or switch into tab share.')
        updateRoomParam(roomId)
        persistSession(roomId)

        // Ask the other person to re-send their live media, and push ours if we already have it.
        window.setTimeout(() => {
          forceRenegotiateAsOfferer('joined-room')
          socketRef.current?.emit('playback-request', { roomId })
        }, 250)
      },
    )
  }

  async function handleStartShare() {
    if (!isSecureContext) {
      setStatusMessage('Screen sharing requires HTTPS or localhost.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 60 },
          width: { ideal: 1920, max: 3840 },
          height: { ideal: 1080, max: 2160 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
        },
        // Chrome built-in options (safely ignored elsewhere).
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      } as DisplayMediaStreamOptions)

      await Promise.all(
        stream.getVideoTracks().map((track) =>
          track
            .applyConstraints({
              frameRate: { ideal: 30, max: 60 },
              width: { ideal: 1920, max: 3840 },
              height: { ideal: 1080, max: 2160 },
            })
            .catch(() => undefined),
        ),
      )

      displayStreamRef.current = stream
      setSharingDisplay(true)
      setSharePaused(false)
      socketRef.current?.emit('set-mode', {
        roomId: activeRoomRef.current,
        mode: 'share',
      })
      socketRef.current?.emit('share-control', {
        roomId: activeRoomRef.current,
        action: 'play',
      })

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        void handleStopShare()
      })

      // Always force a fresh offer — a previous solo offer can leave the peer
      // stuck in have-local-offer so the partner never receives tracks.
      forceRenegotiateAsOfferer('share-started')
      const hasTabAudio = stream.getAudioTracks().length > 0
      setStatusMessage(
        hasTabAudio
          ? 'Sharing tab with audio · fullscreen the movie for best quality.'
          : 'Sharing tab · In Chrome, check “Also share tab audio” for movie sound.',
      )
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Screen share was cancelled.')
    }
  }

  async function handleStopShare() {
    stopStream(displayStreamRef.current)
    displayStreamRef.current = null
    setSharingDisplay(false)
    setSharePaused(false)

    socketRef.current?.emit('set-mode', {
      roomId: activeRoomRef.current,
      mode: 'embed',
    })
    socketRef.current?.emit('media-stopped', {
      roomId: activeRoomRef.current,
      kind: 'display',
    })

    if (peerRef.current && activeRoomRef.current) {
      void syncOfferNow()
    }

    setStatusMessage('Share stopped for everyone in the room.')
  }

  function applyShareControl(action: 'play' | 'pause', actorName?: string) {
    const paused = action === 'pause'
    setSharePaused(paused)

    if (displayStreamRef.current) {
      for (const track of displayStreamRef.current.getTracks()) {
        track.enabled = !paused
      }
    }

    const remoteVideo = remoteDisplayVideoRef.current
    const localVideo = localDisplayVideoRef.current

    if (paused) {
      remoteVideo?.pause()
      localVideo?.pause()
      setStatusMessage(
        `${actorName ?? 'Someone'} paused the shared feed (the movie site itself may keep playing).`,
      )
    } else {
      void remoteVideo?.play().catch(() => undefined)
      void localVideo?.play().catch(() => undefined)
      setStatusMessage(`${actorName ?? 'Someone'} resumed playback.`)
    }
  }

  applyShareControlRef.current = applyShareControl

  function emitShareControl(action: 'play' | 'pause') {
    if (!activeRoomRef.current) {
      return
    }

    applyShareControl(action, 'You')
    socketRef.current?.emit('share-control', {
      roomId: activeRoomRef.current,
      action,
    })
  }

  function toggleSharePlayback() {
    emitShareControl(sharePaused ? 'play' : 'pause')
  }

  function runLocalCountdown(targetAt: number, onDone?: () => void) {
    const tick = () => {
      const remainingMs = targetAt - Date.now()
      if (remainingMs <= 0) {
        setCueText('PLAY!')
        onDone?.()
        window.setTimeout(() => setCueText(''), 1200)
        return
      }

      setCueText(String(Math.ceil(remainingMs / 1000)))
      window.setTimeout(tick, 200)
    }

    tick()
  }

  function applyWatchCue(action: 'play' | 'pause' | 'countdown', at?: number, actorName?: string) {
    if (action === 'countdown') {
      runLocalCountdown(Number(at) || Date.now() + 3000, () => {
        if (roomLinkInputRef.current.trim()) {
          window.open(roomLinkInputRef.current.trim(), '_blank', 'noopener,noreferrer')
        }
      })
      setStatusMessage(`${actorName ?? 'Partner'} started a play countdown.`)
      return
    }

    setCueText(action === 'play' ? 'PLAY!' : 'PAUSE!')
    window.setTimeout(() => setCueText(''), 1400)
    setStatusMessage(
      action === 'play'
        ? `${actorName ?? 'Partner'} says press Play now.`
        : `${actorName ?? 'Partner'} says press Pause now.`,
    )
  }

  applyWatchCueRef.current = applyWatchCue

  function emitWatchCue(action: 'play' | 'pause' | 'countdown') {
    if (!activeRoomRef.current) {
      return
    }

    if (action === 'countdown') {
      const at = Date.now() + 3000
      applyWatchCue('countdown', at, 'You')
      socketRef.current?.emit('watch-cue', {
        roomId: activeRoomRef.current,
        action: 'countdown',
        at,
      })
      setStatusMessage('Countdown started on both sides. Press play on the movie when it hits PLAY!')
      return
    }

    applyWatchCue(action, Date.now(), 'You')
    socketRef.current?.emit('watch-cue', {
      roomId: activeRoomRef.current,
      action,
      at: Date.now(),
    })
  }

  function openMovieOnBothHint() {
    if (!roomLinkInput.trim()) {
      setStatusMessage('Paste the movie link first.')
      return
    }

    window.open(roomLinkInput.trim(), '_blank', 'noopener,noreferrer')
    setStatusMessage('Link opened. Use Countdown to Play so you both start together.')
  }

  async function handleToggleCall() {
    if (!isSecureContext) {
      setStatusMessage('Camera/mic requires HTTPS or localhost.')
      return
    }

    if (callEnabled) {
      stopStream(cameraStreamRef.current)
      cameraStreamRef.current = null
      setLocalCameraPreview(null)
      setCallEnabled(false)

      socketRef.current?.emit('media-stopped', {
        roomId: activeRoomRef.current,
        kind: 'camera',
      })

      if (peerRef.current && activeRoomRef.current) {
        void syncOfferNow()
      }

      setStatusMessage('Camera/mic stopped.')
      return
    }

    try {
      let stream: MediaStream | null = null

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 24, max: 30 },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 48000,
          },
        })
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
              sampleRate: 48000,
            },
          })
          setStatusMessage('No camera found. Audio only.')
        } catch {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                width: { ideal: 1280, max: 1920 },
                height: { ideal: 720, max: 1080 },
                frameRate: { ideal: 24, max: 30 },
              },
              audio: false,
            })
            setStatusMessage('No microphone found. Video only.')
          } catch (innerError) {
            throw innerError
          }
        }
      }

      if (!stream) {
        setStatusMessage('No camera or microphone available.')
        return
      }

      cameraStreamRef.current = stream
      const videoTracks = stream.getVideoTracks()
      setLocalCameraPreview(videoTracks.length ? new MediaStream(videoTracks) : null)
      setCallEnabled(true)

      // Soft sync — do not tear down an existing peer or both cameras die.
      forceRenegotiateAsOfferer('camera-started')
      setStatusMessage(
        videoTracks.length
          ? 'Camera/mic on. Waiting for partner camera…'
          : 'Mic on (no camera). Waiting for partner audio…',
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)

      if (msg.includes('NotFoundError') || msg.includes('Requested device not found')) {
        setStatusMessage('No camera or microphone detected on this device.')
      } else if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        setStatusMessage('Camera/mic permission was denied. Check browser settings.')
      } else {
        setStatusMessage(`Camera/mic error: ${msg}`)
      }
    }
  }

  function handleShareLinkSubmit() {
    if (!activeRoomRef.current || !roomLinkInput.trim()) {
      setStatusMessage('Paste a link before trying embedded view.')
      return
    }

    const link = roomLinkInput.trim()
    const syncable = Boolean(extractYouTubeId(link) || detectDirectVideo(link))

    setEmbedLoaded(false)
    socketRef.current?.emit('set-room-link', {
      roomId: activeRoomRef.current,
      roomLink: link,
    })
    persistSession(activeRoomRef.current, link)

    if (syncable) {
      setStatusMessage('Opening synced player. Play/pause will match on both sides.')
      return
    }

    // Generic movie sites cannot sync iframe players across browsers.
    socketRef.current?.emit('set-mode', {
      roomId: activeRoomRef.current,
      mode: 'share',
    })
    setStatusMessage(
      'This site cannot sync inside the app. Open it in a browser tab, then click Share browser tab + audio so both of you see the same stream.',
    )
  }

  function handleSendMessage(event?: React.FormEvent) {
    event?.preventDefault()

    if (!draftMessage.trim() || !activeRoomRef.current) {
      return
    }

    socketRef.current?.emit('chat-message', {
      roomId: activeRoomRef.current,
      text: draftMessage.trim(),
    })
    setDraftMessage('')
  }

  function handleChatKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSendMessage()
    }
  }

  function sendReaction(emoji: string) {
    if (!activeRoomRef.current) {
      return
    }

    socketRef.current?.emit('reaction', {
      roomId: activeRoomRef.current,
      emoji,
    })
  }

  async function copyInviteLink() {
    if (!inviteLink) {
      return
    }

    await navigator.clipboard.writeText(inviteLink)
    setStatusMessage('Invite link copied.')
  }

  async function toggleTheaterFullscreen() {
    const frame = theaterFrameRef.current

    if (!frame) {
      return
    }

    try {
      if (!document.fullscreenElement) {
        await frame.requestFullscreen()
        setIsTheaterFullscreen(true)
        socketRef.current?.emit('theater-fullscreen', {
          roomId: activeRoomRef.current,
          active: true,
        })
      } else {
        await document.exitFullscreen()
        setIsTheaterFullscreen(false)
        socketRef.current?.emit('theater-fullscreen', {
          roomId: activeRoomRef.current,
          active: false,
        })
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Fullscreen is not available.')
    }
  }

  useEffect(() => {
    function onFullscreenChange() {
      const active = document.fullscreenElement === theaterFrameRef.current
      setIsTheaterFullscreen(active)
    }

    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Space') {
        return
      }

      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        return
      }

      if (!(sharingDisplay || remoteDisplayStream)) {
        return
      }

      event.preventDefault()
      toggleSharePlayback()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [remoteDisplayStream, sharePaused, sharingDisplay])

  const shareActive = sharingDisplay || Boolean(remoteDisplayStream)

  useEffect(() => {
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      path: '/socket.io',
      reconnection: true,
      reconnectionAttempts: 12,
      timeout: 12000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setSocketConnected(true)

      if (activeRoomRef.current && displayNameRef.current.trim()) {
        rejoinRoom()
      } else {
        const urlRoom = new URLSearchParams(window.location.search).get('room')

        if (urlRoom && displayNameRef.current.trim()) {
          activeRoomRef.current = urlRoom
          socket.emit(
            'join-room',
            {
              roomId: urlRoom,
              displayName: displayNameRef.current.trim(),
              roomLink: roomLinkInputRef.current.trim(),
            },
            (response: { ok: boolean; room?: RoomState; isHost?: boolean }) => {
              if (response.ok && response.room) {
                setJoinedRoomId(urlRoom)
                setRoomState(response.room)
                setIsHost(Boolean(response.isHost))
                isHostRef.current = Boolean(response.isHost)
                setStatusMessage('Joined room from invite link.')
              } else {
                setStatusMessage('Room not found or expired. Create a new one.')
                activeRoomRef.current = ''
              }
            },
          )
        } else {
          setStatusMessage((current) =>
            current.includes('disconnected') || current.includes('signaling')
              ? 'Reconnected.'
              : current,
          )
        }
      }
    })

    socket.on('connect_error', (error) => {
      setSocketConnected(false)
      setStatusMessage(
        `Cannot reach signaling server at ${SERVER_URL}. ${
          import.meta.env.VITE_SOCKET_URL
            ? error.message
            : 'For Netlify, set VITE_SOCKET_URL to your Socket.IO host (Render/Railway).'
        }`,
      )
    })

    socket.on('disconnect', () => {
      setSocketConnected(false)
      setStatusMessage('Socket disconnected. Waiting to reconnect...')
    })

    socket.on('room-state', (nextRoom: RoomState) => {
      setRoomState(nextRoom)
      if (typeof nextRoom.sharePaused === 'boolean') {
        setSharePaused(nextRoom.sharePaused)
      }
    })

    socket.on(
      'presence',
      ({ type, displayName: participantName }: { type: 'joined' | 'left'; displayName: string }) => {
        setStatusMessage(`${participantName} ${type === 'joined' ? 'joined' : 'left'} the room.`)

        if (type === 'joined') {
          window.setTimeout(() => {
            forceRenegotiateAsOfferer('peer-joined')
          }, 300)
        }

        if (type === 'left') {
          destroyPeer()
          if (displayStreamRef.current || cameraStreamRef.current) {
            pushLocalMediaIfAny(true)
          }
        }
      },
    )

    socket.on('renegotiate', (payload?: { reason?: string }) => {
      window.setTimeout(() => {
        forceRenegotiateAsOfferer(payload?.reason ?? 'renegotiate')
      }, 200)
    })

    socket.on('request-media-sync', () => {
      const peer = getOrCreatePeer()
      if (displayStreamRef.current) {
        attachLocalTracks(peer, displayStreamRef.current, 'display')
      }
      if (cameraStreamRef.current) {
        attachLocalTracks(peer, cameraStreamRef.current, 'camera')
      }
      void syncOfferNow(true)
    })

    socket.on(
      'media-stopped',
      ({
        kind,
        displayName: stopperName,
      }: {
        kind: 'display' | 'camera' | 'all'
        displayName?: string
      }) => {
        if (kind === 'display' || kind === 'all') {
          hasReceivedDisplayRef.current = false
          setRemoteDisplayStream(null)
          setStatusMessage(`${stopperName ?? 'Partner'} stopped the shared stream.`)
        }

        if (kind === 'camera' || kind === 'all') {
          setRemoteCameraStream(null)
          if (kind === 'camera') {
            setStatusMessage(`${stopperName ?? 'Partner'} stopped their camera.`)
          }
        }
      },
    )

    socket.on(
      'theater-fullscreen',
      ({ active, displayName: actorName }: { active: boolean; displayName?: string }) => {
        setStatusMessage(
          `${actorName ?? 'Partner'} ${active ? 'entered' : 'exited'} watch-together fullscreen.`,
        )
      },
    )

    socket.on(
      'playback-sync',
      (payload: {
        type: 'play' | 'pause' | 'seek'
        positionSec: number
        isPlaying?: boolean
        fromSocketId?: string | null
      }) => {
        if (payload.fromSocketId && payload.fromSocketId === socket.id) {
          return
        }

        applyPlaybackSyncRef.current?.({
          type: payload.type,
          positionSec: payload.positionSec,
          isPlaying: payload.isPlaying,
        })
      },
    )

    socket.on(
      'share-control',
      ({
        action,
        displayName: actorName,
      }: {
        action: 'play' | 'pause'
        sharePaused?: boolean
        displayName?: string
      }) => {
        applyShareControlRef.current?.(action, actorName)
      },
    )

    socket.on(
      'watch-cue',
      ({
        action,
        at,
        displayName: actorName,
      }: {
        action: 'play' | 'pause' | 'countdown'
        at?: number
        displayName?: string
      }) => {
        applyWatchCueRef.current?.(action, at, actorName)
      },
    )

    socket.on('chat-message', (message: ChatMessage) => {
      setRoomState((current) => {
        if (!current) {
          return current
        }

        const nextMessages = [...current.messages, message].slice(-50)
        return { ...current, messages: nextMessages }
      })
    })

    socket.on('reaction', (reaction: ReactionPayload) => {
      setReactions((current) => [...current, reaction])
      window.setTimeout(() => {
        setReactions((current) => current.filter((entry) => entry.sentAt !== reaction.sentAt))
      }, 2200)
    })

    socket.on('signal', async ({ fromSocketId, payload }: { fromSocketId?: string; payload: SignalPayload }) => {
      const peer = getOrCreatePeer()
      const myId = socket.id ?? ''

      // Lower socket id is polite (backs off on glare).
      politeRef.current = myId < (fromSocketId ?? '')

      for (const streamId of payload.displayStreamIds ?? []) {
        remoteDisplayStreamIdsRef.current.add(streamId)
      }

      for (const streamId of payload.cameraStreamIds ?? []) {
        remoteCameraStreamIdsRef.current.add(streamId)
      }

      try {
        if (payload.description) {
          const offerCollision =
            payload.description.type === 'offer' &&
            (makingOfferRef.current || peer.signalingState !== 'stable')

          ignoreOfferRef.current = !politeRef.current && offerCollision

          if (ignoreOfferRef.current) {
            return
          }

          if (offerCollision && politeRef.current) {
            await Promise.all([
              peer.setLocalDescription({ type: 'rollback' }),
              peer.setRemoteDescription(payload.description),
            ])
          } else {
          await peer.setRemoteDescription(payload.description)
          }
          await flushPendingIce(peer)

          if (payload.description.type === 'offer') {
            // Ensure our local tracks are attached before answering.
            if (displayStreamRef.current) {
              attachLocalTracks(peer, displayStreamRef.current, 'display')
            }
            if (cameraStreamRef.current) {
              attachLocalTracks(peer, cameraStreamRef.current, 'camera')
            }

            preferVideoCodecs(peer)
            const answer = await peer.createAnswer()
            await peer.setLocalDescription(answer)
            void optimizePeerSenders(peer)

            if (activeRoomRef.current) {
              socket.emit('signal', {
                roomId: activeRoomRef.current,
                payload: {
                  description: answer,
                  displayStreamIds: displayStreamRef.current ? [displayStreamRef.current.id] : [],
                  cameraStreamIds: cameraStreamRef.current ? [cameraStreamRef.current.id] : [],
                },
              })
            }
          }
        }

        if (payload.candidate) {
          if (!peer.remoteDescription) {
            pendingIceRef.current.push(payload.candidate)
          } else {
            await peer.addIceCandidate(payload.candidate)
          }
        }
      } catch (error) {
        setStatusMessage(
          error instanceof Error ? `Sync error: ${error.message}` : 'Sync error between peers.',
        )
      }
    })

    return () => {
      socket.disconnect()
      stopStream(displayStreamRef.current)
      stopStream(cameraStreamRef.current)
      destroyPeer()
    }
  }, [getOrCreatePeer])

  useEffect(() => {
    const video = remoteDisplayVideoRef.current
    if (video && remoteDisplayStream) {
      video.srcObject = remoteDisplayStream
      void video.play().catch(() => undefined)
    }
  }, [remoteDisplayStream])

  useEffect(() => {
    const video = localDisplayVideoRef.current
    if (video && displayStreamRef.current && sharingDisplay) {
      video.srcObject = displayStreamRef.current
      void video.play().catch(() => undefined)
    }
  }, [sharingDisplay])

  useEffect(() => {
    const video = localCameraRef.current
    if (video && localCameraPreview) {
      video.srcObject = localCameraPreview
      void video.play().catch(() => undefined)
    }
  }, [localCameraPreview])

  useEffect(() => {
    const video = remoteCameraRef.current
    if (video && remoteCameraStream) {
      video.srcObject = remoteCameraStream
      void video.play().catch(() => undefined)
    }
  }, [remoteCameraStream])

  useEffect(() => {
    const audio = remoteAudioRef.current
    if (audio && remoteAudioStream) {
      audio.srcObject = remoteAudioStream
      audio.muted = false
      audio.volume = 1
      void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true))
    }
  }, [remoteAudioStream])

  async function unlockRemoteAudio() {
    const audio = remoteAudioRef.current
    if (!audio) {
      return
    }

    audio.muted = false
    audio.volume = 1
    try {
      await audio.play()
      setAudioBlocked(false)
      setStatusMessage('Partner audio unlocked.')
    } catch {
      setAudioBlocked(true)
      setStatusMessage('Click again to allow sound, or check browser site settings.')
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sortedMessages.length])

  useEffect(() => {
    if (!roomState || roomState.mode !== 'embed' || !roomState.roomLink) {
      if (fallbackTimerRef.current) {
        window.clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
      return
    }

    fallbackTimerRef.current = window.setTimeout(() => {
      if (!embedLoaded) {
        // Known providers often fire onLoad slowly; give them more room before blocking.
        if (isKnownEmbedProvider) {
          return
        }

        socketRef.current?.emit('set-embed-status', {
          roomId: roomState.roomId,
          status: 'blocked',
        })
      }
    }, isKnownEmbedProvider ? 12000 : 8000)

    return () => {
      if (fallbackTimerRef.current) {
        window.clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
    }
  }, [embedLoaded, isKnownEmbedProvider, roomState?.roomLink, roomState?.mode, roomState?.roomId])

  return (
    <main className="app-shell">
      <section className="hero-panel card">
        <div>
          <p className="eyebrow">Bella Stream</p>
          <h1>Private watch rooms with embedded links and tab-share fallback.</h1>
          <p className="subtle">
            {isMobileDevice
              ? 'On phones: YouTube/direct videos sync perfectly. For other movie sites, open the link on both phones and use the shared Play/Pause cues.'
              : 'Paste a YouTube link for synced watching, or use Chrome’s built-in tab/window share for other sites.'}
          </p>
        </div>

        <div className="status-row">
          <span className={`pill ${socketConnected ? 'ok' : 'warn'}`}>
            {socketConnected ? 'Socket connected' : 'Reconnecting'}
          </span>
          <span className="pill neutral">Peer: {peerStatus}</span>
          {roomState?.participants.length ? (
            <span className="pill neutral">{roomState.participants.length}/2 in room</span>
          ) : null}
          {!isSecureContext ? <span className="pill warn">Not HTTPS</span> : null}
          {isMobileDevice ? (
            <span className="pill ok">Mobile mode</span>
          ) : (
            <span className="pill ok">Chrome tab share</span>
          )}
        </div>

        {NEEDS_SOCKET_SETUP ? (
          <div className="fallback-banner" style={{ marginTop: 16 }}>
            <strong>Signaling server not configured</strong>
            <p>
              Netlify only hosts the UI. Deploy the Socket.IO server on Render, then in Netlify set{' '}
              <code>VITE_SOCKET_URL</code> to that Render URL and trigger a new deploy. Until then rooms
              cannot connect.
            </p>
          </div>
        ) : null}
      </section>

      <section className="setup-grid">
        <div className="card">
          <h2>Join your room</h2>
          <div className="field-group">
            <label>
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Bella or Alex"
              />
            </label>
            <label>
              Room code
              <input
                value={pendingRoomId}
                onChange={(event) => setPendingRoomId(event.target.value.toLowerCase())}
                placeholder="xk29a"
              />
            </label>
          </div>
          <div className="actions">
            <button type="button" onClick={handleCreateRoom}>
              Create private room
            </button>
            <button type="button" className="ghost" onClick={() => handleJoinRoom()}>
              Join room
            </button>
          </div>
          <p className="subtle">{statusMessage}</p>
        </div>

        <div className="card">
          <h2>Invite and resume</h2>
          <div className="field-group">
            <label>
              Invite link
              <input readOnly value={inviteLink} placeholder="Create or join a room first" />
            </label>
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={copyInviteLink} disabled={!inviteLink}>
              Copy invite
            </button>
          </div>
          <p className="subtle">
            Your latest name, room, and pasted link are saved locally so you can pick back up later.
          </p>
        </div>
      </section>

      <section className="watch-layout">
        <div className="player-column">
          <div className="card controls-card">
            <div className="controls-header">
              <div>
                <h2>Watch controls</h2>
                <p className="subtle">Paste a link, try embedded view, or jump straight into tab sharing.</p>
              </div>
              <div className="mode-toggle">
                <button
                  type="button"
                  className={roomState?.mode === 'embed' ? 'active' : ''}
                  onClick={() =>
                    activeRoomRef.current &&
                    socketRef.current?.emit('set-mode', { roomId: activeRoomRef.current, mode: 'embed' })
                  }
                >
                  Embedded mode
                </button>
                <button
                  type="button"
                  className={roomState?.mode === 'share' ? 'active' : ''}
                  onClick={() =>
                    activeRoomRef.current &&
                    socketRef.current?.emit('set-mode', { roomId: activeRoomRef.current, mode: 'share' })
                  }
                >
                  Share mode
                </button>
              </div>
            </div>

            <div className="field-group">
              <label>
                Paste any link
                <input
                  value={roomLinkInput}
                  onChange={(event) => setRoomLinkInput(event.target.value)}
                  placeholder="https://example.com/movie-page"
                />
              </label>
            </div>
            <div className="actions">
              <button
                type="button"
                className={inputCanSync || !roomLinkInput.trim() ? '' : 'ghost'}
                onClick={handleShareLinkSubmit}
                disabled={!activeRoom}
              >
                {inputCanSync || !roomLinkInput.trim()
                  ? 'Try synced embed'
                  : 'This site needs tab share'}
              </button>
              <button
                type="button"
                className={!inputCanSync && roomLinkInput.trim() ? '' : 'ghost'}
                onClick={() => void handleStartShare()}
                disabled={!activeRoom || !canScreenShare}
                title={
                  !canScreenShare
                    ? 'Screen share is limited on this phone/browser'
                    : 'Uses Chrome’s share picker — choose a tab, or a PiP window for mostly-movie view'
                }
              >
                {canScreenShare ? 'Share with Chrome' : 'Screen share unavailable'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={openMovieOnBothHint}
                disabled={!activeRoom || !roomLinkInput.trim()}
              >
                Open movie link
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => emitWatchCue('countdown')}
                disabled={!activeRoom}
              >
                Countdown to Play
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => emitWatchCue('pause')}
                disabled={!activeRoom}
              >
                Cue Pause
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => emitWatchCue('play')}
                disabled={!activeRoom}
              >
                Cue Play
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void handleStopShare()
                }}
                disabled={!sharingDisplay}
              >
                Stop share
              </button>
              <button type="button" className="ghost" onClick={() => void handleToggleCall()} disabled={!activeRoom}>
                {callEnabled ? 'Stop voice/camera' : 'Start voice/camera'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!activeRoom}
                onClick={() => {
                  forceRenegotiateAsOfferer('manual-resync')
                  setStatusMessage('Resync requested. Reconnecting live feed...')
                }}
              >
                Resync feed
              </button>
              {audioBlocked || remoteAudioStream ? (
                <button type="button" className={audioBlocked ? '' : 'ghost'} onClick={() => void unlockRemoteAudio()}>
                  {audioBlocked ? 'Enable sound' : 'Replay sound'}
                </button>
              ) : null}
            </div>

            <div className="helper-row">
              <span className={`pill ${roomState?.embedStatus === 'blocked' ? 'warn' : 'neutral'}`}>
                Embed status: {roomState?.embedStatus ?? 'idle'}
              </span>
              <span className={`pill ${inputCanSync ? 'ok' : roomLinkInput.trim() ? 'warn' : 'neutral'}`}>
                {inputCanSync
                  ? 'Synced playback available'
                  : roomLinkInput.trim()
                    ? 'Share tab or PiP window with Chrome'
                    : 'Paste a link'}
              </span>
              <span className="pill neutral">
                Host: {isHost ? 'You' : hostParticipant?.displayName ?? 'Waiting'}
              </span>
            </div>
          </div>

          <div className="card theater-card">
            <div className="theater-toolbar">
              <div>
                <h2>Theater</h2>
                <p className="subtle">Watch together with camera bubbles over the stream.</p>
              </div>
              <div className="actions compact">
                <button type="button" className="ghost" onClick={() => void toggleTheaterFullscreen()}>
                  {isTheaterFullscreen ? 'Exit fullscreen' : 'Watch together fullscreen'}
                </button>
              </div>
            </div>

            <div
              ref={theaterFrameRef}
              className={`theater-frame ${isTheaterFullscreen ? 'is-fullscreen' : ''}`}
            >
              <div className="bubble-overlay">
                <div className="bubble-stack">
                  {localCameraPreview ? (
                    <div className="bubble-card you">
                      <video ref={localCameraRef} autoPlay playsInline muted className="bubble-video" />
                      <span className="bubble-label">You</span>
                    </div>
                  ) : null}
                  {callEnabled || remoteCameraStream ? (
                    <div className={`bubble-card partner ${remoteCameraStream ? '' : 'waiting'}`.trim()}>
                      {remoteCameraStream ? (
                        <video
                          ref={remoteCameraRef}
                          autoPlay
                          playsInline
                          muted={false}
                          className="bubble-video"
                        />
                      ) : null}
                      <span className="bubble-label">
                        {remoteCameraStream ? 'Partner' : 'Waiting for partner camera…'}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>

              {isTheaterFullscreen ? (
                <button
                  type="button"
                  className="fullscreen-exit"
                  onClick={() => void toggleTheaterFullscreen()}
                >
                  Exit fullscreen
                </button>
              ) : null}

              {cueText ? (
                <div className="watch-cue-overlay">
                  <strong>{cueText}</strong>
                </div>
              ) : null}

              {shareActive ? (
                <div className="share-controls">
                  <button type="button" className="share-play-btn" onClick={toggleSharePlayback}>
                    {sharePaused ? 'Play' : 'Pause'}
                  </button>
                  <span className="share-control-hint">
                    Tip: share the Chrome tab and enable “Also share tab audio” · fullscreen the movie for sharpest quality
                  </span>
                </div>
              ) : null}

              {shareActive && sharePaused ? (
                <div className="share-paused-overlay">
                  <strong>Paused</strong>
                  <p>Stream frozen for both of you</p>
                </div>
              ) : null}

              {remoteDisplayStream ? (
                <video
                  ref={remoteDisplayVideoRef}
                  autoPlay
                  playsInline
                  className="player-surface"
                />
              ) : sharingDisplay ? (
                <video
                  ref={localDisplayVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="player-surface"
                />
              ) : roomState?.mode === 'share' ? (
                  <div className="empty-state">
                    <h3>Waiting for live share</h3>
                    <p>Host is in share mode. If the feed does not appear, click Share browser tab + audio again.</p>
                  </div>
              ) : roomState?.roomLink ? (
                canUseDirectVideo ? (
                  <SyncedHtmlVideo
                    src={roomState.roomLink}
                    emitPlayback={emitPlayback}
                    registerApplySync={registerApplySync}
                    onReady={() => {
                      setEmbedLoaded(true)
                      socketRef.current?.emit('set-embed-status', {
                        roomId: roomState.roomId,
                        status: 'ready',
                      })
                      socketRef.current?.emit('playback-request', { roomId: roomState.roomId })
                    }}
                  />
                ) : youtubeId ? (
                  <SyncedYouTubePlayer
                    videoId={youtubeId}
                    roomId={roomState.roomId}
                    emitPlayback={emitPlayback}
                    registerApplySync={registerApplySync}
                    onReady={() => {
                      setEmbedLoaded(true)
                      socketRef.current?.emit('set-embed-status', {
                        roomId: roomState.roomId,
                        status: 'ready',
                      })
                      socketRef.current?.emit('playback-request', { roomId: roomState.roomId })
                    }}
                  />
                ) : (
                  <iframe
                    title="Embedded room link"
                    src={embedUrl}
                    className="player-surface"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                    onLoad={() => {
                      setEmbedLoaded(true)
                      socketRef.current?.emit('set-embed-status', {
                        roomId: roomState.roomId,
                        status: 'ready',
                      })
                    }}
                    onError={() => {
                      socketRef.current?.emit('set-embed-status', {
                        roomId: roomState.roomId,
                        status: 'blocked',
                      })
                    }}
                  />
                )
              ) : (
                <div className="empty-state">
                  <h3>Paste a link to begin</h3>
                  <p>
                    Bella Stream tries embedded viewing first, then falls back to live tab sharing when
                    sites block in-room display.
                  </p>
                </div>
              )}

              <div className="reaction-layer">
                {reactions.map((reaction) => (
                  <div key={`${reaction.sentAt}-${reaction.displayName}`} className="reaction-burst">
                    <span>{reaction.emoji}</span>
                    <small>{reaction.displayName}</small>
                  </div>
                ))}
              </div>
            </div>

            {roomState?.embedStatus === 'blocked' || isGenericSiteEmbed ? (
              <div className="fallback-banner">
                <strong>
                  {isGenericSiteEmbed
                    ? 'This site cannot stay in sync inside the room.'
                    : 'This site likely blocked embedded viewing.'}
                </strong>
                <p>
                  Sites like Nunflix cannot sync inside an embed. Use Chrome’s built-in share: on the
                  movie site open <strong>Picture in picture</strong> (right‑click the player), then
                  in Bella click <strong>Share with Chrome</strong> and pick that PiP window — or
                  share the movie tab and fullscreen the video there.
                </p>
                <div className="actions" style={{ marginTop: 12 }}>
                  <button type="button" onClick={() => emitWatchCue('countdown')} disabled={!activeRoom}>
                    Countdown to Play
                  </button>
                  <button type="button" className="ghost" onClick={openMovieOnBothHint} disabled={!roomLinkInput.trim()}>
                    Open movie link
                  </button>
                  {canScreenShare ? (
                    <button type="button" onClick={() => void handleStartShare()} disabled={!activeRoom}>
                      Share with Chrome
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="presence-header">
              <h2>Presence</h2>
              <div className="actions compact">
                {['\u2764\uFE0F', '\uD83D\uDE02', '\uD83D\uDE31', '\uD83D\uDD25'].map((emoji) => (
                  <button key={emoji} type="button" className="ghost emoji-button" onClick={() => sendReaction(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            <div className="participant-list">
              {(roomState?.participants ?? []).map((participant) => (
                <div key={participant.id} className="participant">
                  <div>
                    <strong>{participant.displayName}</strong>
                    <p className="subtle">Joined {shortTime(participant.joinedAt)}</p>
                  </div>
                  {roomState?.hostSocketId === participant.id ? <span className="pill ok">Host</span> : null}
                </div>
              ))}
            </div>

            <audio ref={remoteAudioRef} autoPlay playsInline controls={false} />
          </div>
        </div>

        <aside className="card chat-column">
          <div className="chat-header">
            <div>
              <h2>Room chat</h2>
              <p className="subtle">Messages last for the life of the room and reappear when you reconnect.</p>
            </div>
          </div>

          <div className="chat-log">
            {sortedMessages.length ? (
              sortedMessages.map((message) => (
                <article key={message.id} className="chat-message">
                  <div className="chat-meta">
                    <strong>{message.displayName}</strong>
                    <span>{shortTime(message.sentAt)}</span>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))
            ) : (
              <div className="empty-chat">Say hi before the movie starts.</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="chat-form" onSubmit={handleSendMessage}>
            <textarea
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="Send a message... (Enter to send, Shift+Enter for newline)"
              rows={3}
            />
            <button type="submit" disabled={!activeRoom}>
              Send
            </button>
          </form>
        </aside>
      </section>
    </main>
  )
}

export default App
