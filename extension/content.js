function findVideos(doc = document) {
  return [...doc.querySelectorAll('video')].filter((video) => {
    const rect = video.getBoundingClientRect()
    return rect.width >= 160 && rect.height >= 90
  })
}

function scoreVideo(video) {
  const rect = video.getBoundingClientRect()
  const area = Math.max(0, rect.width) * Math.max(0, rect.height)
  const playingBonus = video.paused ? 0 : 250000
  const readyBonus = video.readyState >= 2 ? 50000 : 0
  return area + playingBonus + readyBonus
}

function pickBestVideo() {
  const videos = findVideos()
  if (!videos.length) {
    return null
  }

  videos.sort((a, b) => scoreVideo(b) - scoreVideo(a))
  return videos[0]
}

function controlVideos(action) {
  const videos = findVideos()
  let handled = 0

  for (const video of videos) {
    try {
      if (action === 'pause') {
        video.pause()
        handled += 1
      }

      if (action === 'play') {
        const playResult = video.play()
        if (playResult?.catch) {
          playResult.catch(() => undefined)
        }
        handled += 1
      }
    } catch {
      // Ignore locked/cross-origin media errors.
    }
  }

  if (handled === 0) {
    const selectors =
      action === 'pause'
        ? [
            'button[aria-label*="Pause" i]',
            'button[title*="Pause" i]',
            '.vjs-play-control.vjs-playing',
            '.ytp-play-button',
          ]
        : [
            'button[aria-label*="Play" i]',
            'button[title*="Play" i]',
            '.vjs-play-control.vjs-paused',
            '.ytp-play-button',
          ]

    for (const selector of selectors) {
      const button = document.querySelector(selector)
      if (button instanceof HTMLElement) {
        button.click()
        handled += 1
        break
      }
    }
  }

  return handled
}

let capturePeer = null
let captureStream = null

function cleanupCapture() {
  if (captureStream) {
    for (const track of captureStream.getTracks()) {
      track.stop()
    }
    captureStream = null
  }

  if (capturePeer) {
    capturePeer.onicecandidate = null
    capturePeer.onconnectionstatechange = null
    capturePeer.close()
    capturePeer = null
  }
}

async function startMovieCapture() {
  const video = pickBestVideo()
  if (!video) {
    return { ok: false, reason: 'no-video' }
  }

  cleanupCapture()

  try {
    await video.play().catch(() => undefined)
  } catch {
    // Autoplay may be blocked; captureStream can still work if already playing.
  }

  const captureFn =
    typeof video.captureStream === 'function'
      ? video.captureStream.bind(video)
      : typeof video.mozCaptureStream === 'function'
        ? video.mozCaptureStream.bind(video)
        : null

  if (!captureFn) {
    return { ok: false, reason: 'no-video' }
  }

  captureStream = captureFn()
  if (!captureStream?.getTracks?.().length) {
    return { ok: false, reason: 'empty-stream' }
  }

  capturePeer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })

  for (const track of captureStream.getTracks()) {
    capturePeer.addTrack(track, captureStream)
  }

  capturePeer.onicecandidate = (event) => {
    if (!event.candidate) {
      return
    }

    chrome.runtime.sendMessage({
      source: 'bella-stream',
      type: 'movie-capture-signal',
      payload: { candidate: event.candidate.toJSON() },
    })
  }

  const offer = await capturePeer.createOffer()
  await capturePeer.setLocalDescription(offer)

  chrome.runtime.sendMessage({
    source: 'bella-stream',
    type: 'movie-capture-signal',
    payload: {
      description: capturePeer.localDescription,
    },
  })

  return {
    ok: true,
    label: document.title || location.hostname,
    trackCount: captureStream.getTracks().length,
  }
}

async function handleCaptureSignal(payload) {
  if (!capturePeer || !payload) {
    return
  }

  if (payload.description) {
    await capturePeer.setRemoteDescription(payload.description)
  }

  if (payload.candidate) {
    try {
      await capturePeer.addIceCandidate(payload.candidate)
    } catch {
      // Ignore stale candidates.
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== 'bella-stream') {
    return
  }

  if (message.type === 'share-control' && (message.action === 'play' || message.action === 'pause')) {
    const handled = controlVideos(message.action)
    sendResponse({ ok: true, handled })
    return true
  }

  if (message.type === 'probe-video') {
    const video = pickBestVideo()
    sendResponse({
      ok: Boolean(video),
      score: video ? scoreVideo(video) : 0,
      title: document.title || location.hostname,
      href: location.href,
    })
    return false
  }

  if (message.type === 'start-movie-capture') {
    startMovieCapture()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, reason: String(error) }))
    return true
  }

  if (message.type === 'movie-capture-signal') {
    // If this is the movie tab peer, handle WebRTC signal.
    if (capturePeer) {
      handleCaptureSignal(message.payload)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }))
      return true
    }

    // If this is the Bella Stream tab, forward into the page app.
    window.postMessage(
      {
        source: 'bella-stream-extension',
        type: 'movie-capture-signal',
        payload: message.payload,
      },
      '*',
    )
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'movie-capture-status') {
    window.postMessage(
      {
        source: 'bella-stream-extension',
        type: 'movie-capture-status',
        ok: message.ok,
        reason: message.reason,
        label: message.label,
      },
      '*',
    )
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'stop-movie-capture') {
    cleanupCapture()
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'ping') {
    sendResponse({ ok: true })
    return true
  }
})

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.source !== 'bella-stream') {
    return
  }

  if (data.type === 'share-control' && (data.action === 'play' || data.action === 'pause')) {
    controlVideos(data.action)
    chrome.runtime.sendMessage({
      source: 'bella-stream',
      type: 'share-control',
      action: data.action,
    })
  }

  if (data.type === 'extension-ping') {
    window.postMessage(
      {
        source: 'bella-stream-extension',
        type: 'extension-pong',
        ok: true,
      },
      '*',
    )
  }

  if (data.type === 'start-movie-capture') {
    chrome.runtime.sendMessage({
      source: 'bella-stream',
      type: 'request-movie-capture',
      roomId: data.roomId,
    })
  }

  if (data.type === 'movie-capture-signal') {
    chrome.runtime.sendMessage({
      source: 'bella-stream',
      type: 'movie-capture-signal-from-app',
      payload: data.payload,
    })
  }

  if (data.type === 'stop-movie-capture') {
    chrome.runtime.sendMessage({
      source: 'bella-stream',
      type: 'stop-movie-capture',
    })
  }
})
