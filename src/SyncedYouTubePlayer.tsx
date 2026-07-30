import { useEffect, useId, useRef } from 'react'

type PlaybackEventType = 'play' | 'pause' | 'seek'

type SyncedYouTubePlayerProps = {
  videoId: string
  roomId: string
  emitPlayback: (type: PlaybackEventType, positionSec: number) => void
  onReady?: () => void
  registerApplySync: (fn: ((payload: SyncPayload) => void) | null) => void
}

export type SyncPayload = {
  type: PlaybackEventType
  positionSec: number
  isPlaying?: boolean
}

type YTPlayer = {
  destroy: () => void
  playVideo: () => void
  pauseVideo: () => void
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
  getCurrentTime: () => number
  getPlayerState: () => number
}

type YTNamespace = {
  Player: new (
    element: HTMLElement | string,
    options: {
      videoId: string
      width?: string | number
      height?: string | number
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: (event: { target: YTPlayer }) => void
        onStateChange?: (event: { data: number; target: YTPlayer }) => void
      }
    },
  ) => YTPlayer
  PlayerState: {
    PLAYING: number
    PAUSED: number
    BUFFERING: number
    CUED: number
    ENDED: number
  }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let youtubeApiPromise: Promise<void> | null = null

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve()
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise
  }

  youtubeApiPromise = new Promise((resolve) => {
    const finish = () => {
      if (window.YT?.Player) {
        resolve()
      }
    }

    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      finish()
    }

    if (!document.querySelector('script[data-bella-youtube]')) {
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.dataset.bellaYoutube = 'true'
      script.onload = () => {
        // API may already be ready by the time onload fires.
        window.setTimeout(finish, 0)
      }
      document.body.appendChild(script)
    } else {
      window.setTimeout(finish, 0)
    }
  })

  return youtubeApiPromise
}

export function SyncedYouTubePlayer({
  videoId,
  emitPlayback,
  onReady,
  registerApplySync,
}: SyncedYouTubePlayerProps) {
  const mountId = useId().replace(/:/g, '')
  const mountRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const ignoringRef = useRef(false)
  const lastEmittedRef = useRef(0)
  const lastLocalTimeRef = useRef(0)
  const emitPlaybackRef = useRef(emitPlayback)
  const onReadyRef = useRef(onReady)
  const registerApplySyncRef = useRef(registerApplySync)

  useEffect(() => {
    emitPlaybackRef.current = emitPlayback
  }, [emitPlayback])

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    registerApplySyncRef.current = registerApplySync
  }, [registerApplySync])

  useEffect(() => {
    let cancelled = false
    let pollTimer: number | null = null

    async function setup() {
      await loadYouTubeApi()
      if (cancelled || !mountRef.current || !window.YT) {
        return
      }

      // Keep a stable outer shell; YouTube replaces the inner mount node.
      mountRef.current.innerHTML = ''
      const target = document.createElement('div')
      target.id = `yt-${mountId}`
      target.style.width = '100%'
      target.style.height = '100%'
      mountRef.current.appendChild(target)

      playerRef.current = new window.YT.Player(target, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            if (cancelled) {
              return
            }

            playerRef.current = event.target
            lastLocalTimeRef.current = event.target.getCurrentTime()
            onReadyRef.current?.()

            pollTimer = window.setInterval(() => {
              const player = playerRef.current
              if (!player || ignoringRef.current) {
                return
              }

              try {
                const current = player.getCurrentTime()
                const previous = lastLocalTimeRef.current
                lastLocalTimeRef.current = current

                if (Math.abs(current - previous) > 1.5) {
                  const now = Date.now()
                  if (now - lastEmittedRef.current > 250) {
                    lastEmittedRef.current = now
                    emitPlaybackRef.current('seek', current)
                  }
                }
              } catch {
                // Player may be mid-destroy during remounts.
              }
            }, 700)
          },
          onStateChange: (event) => {
            if (ignoringRef.current || !window.YT) {
              return
            }

            try {
              const position = event.target.getCurrentTime()
              const now = Date.now()

              if (event.data === window.YT.PlayerState.PLAYING) {
                if (now - lastEmittedRef.current > 200) {
                  lastEmittedRef.current = now
                  emitPlaybackRef.current('play', position)
                }
              }

              if (event.data === window.YT.PlayerState.PAUSED) {
                if (now - lastEmittedRef.current > 200) {
                  lastEmittedRef.current = now
                  emitPlaybackRef.current('pause', position)
                }
              }
            } catch {
              // Ignore transient API errors.
            }
          },
        },
      })
    }

    void setup()

    registerApplySyncRef.current((payload) => {
      const player = playerRef.current
      if (!player) {
        return
      }

      ignoringRef.current = true

      try {
        const current = player.getCurrentTime()

        if (Math.abs(current - payload.positionSec) > 0.75) {
          player.seekTo(payload.positionSec, true)
          lastLocalTimeRef.current = payload.positionSec
        }

        if (payload.type === 'play' || payload.isPlaying === true) {
          player.playVideo()
        } else if (payload.type === 'pause' || payload.isPlaying === false) {
          player.pauseVideo()
        } else if (payload.type === 'seek') {
          // keep current play/pause state after seek
        }
      } catch {
        // Ignore.
      }

      window.setTimeout(() => {
        ignoringRef.current = false
      }, 500)
    })

    return () => {
      cancelled = true
      if (pollTimer) {
        window.clearInterval(pollTimer)
      }
      registerApplySyncRef.current(null)
      try {
        playerRef.current?.destroy()
      } catch {
        // Ignore.
      }
      playerRef.current = null
    }
  }, [mountId, videoId])

  return (
    <div className="player-surface youtube-host">
      <div ref={mountRef} className="youtube-mount" />
    </div>
  )
}
