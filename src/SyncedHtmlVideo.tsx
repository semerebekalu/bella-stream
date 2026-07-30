import { useEffect, useRef } from 'react'
import type { SyncPayload } from './SyncedYouTubePlayer'

type PlaybackEventType = 'play' | 'pause' | 'seek'

type SyncedHtmlVideoProps = {
  src: string
  emitPlayback: (type: PlaybackEventType, positionSec: number) => void
  onReady?: () => void
  registerApplySync: (fn: ((payload: SyncPayload) => void) | null) => void
}

export function SyncedHtmlVideo({
  src,
  emitPlayback,
  onReady,
  registerApplySync,
}: SyncedHtmlVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const ignoringRef = useRef(false)
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
    const video = videoRef.current
    if (!video) {
      return
    }

    const emit = (type: PlaybackEventType) => {
      if (ignoringRef.current) {
        return
      }
      emitPlaybackRef.current(type, video.currentTime)
    }

    const onPlay = () => emit('play')
    const onPause = () => emit('pause')
    const onSeeked = () => emit('seek')
    const onLoaded = () => onReadyRef.current?.()

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('loadeddata', onLoaded)

    registerApplySyncRef.current((payload) => {
      ignoringRef.current = true

      if (Math.abs(video.currentTime - payload.positionSec) > 0.5) {
        video.currentTime = payload.positionSec
      }

      if (payload.type === 'play' || payload.isPlaying === true) {
        void video.play().catch(() => undefined)
      } else if (payload.type === 'pause' || payload.isPlaying === false) {
        video.pause()
      }

      window.setTimeout(() => {
        ignoringRef.current = false
      }, 400)
    })

    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('loadeddata', onLoaded)
      registerApplySyncRef.current(null)
    }
  }, [src])

  return <video ref={videoRef} src={src} controls className="player-surface" playsInline />
}
