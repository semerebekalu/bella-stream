let bellaTabId = null
let movieTabId = null
let movieFrameId = 0

async function broadcastShareControl(action) {
  const tabs = await chrome.tabs.query({})

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return
      }

      try {
        await chrome.tabs.sendMessage(tab.id, {
          source: 'bella-stream',
          type: 'share-control',
          action,
        })
      } catch {
        // Tab may not have the content script yet.
      }
    }),
  )
}

function isSkippableUrl(url = '') {
  return (
    !url ||
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://')
  )
}

async function ensureContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    })
  } catch {
    // Some frames (chrome://, opaque) cannot be injected.
  }
}

async function probeTabsForVideo() {
  const tabs = await chrome.tabs.query({})
  const results = []

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || isSkippableUrl(tab.url)) {
        return
      }

      await ensureContentScripts(tab.id)

      let frameResults = []
      try {
        frameResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: () => {
            const videos = [...document.querySelectorAll('video')].filter((video) => {
              const rect = video.getBoundingClientRect()
              return rect.width >= 120 && rect.height >= 70
            })

            if (!videos.length) {
              return null
            }

            let bestScore = 0
            for (const video of videos) {
              const rect = video.getBoundingClientRect()
              const area = Math.max(0, rect.width) * Math.max(0, rect.height)
              const playingBonus = video.paused ? 0 : 250000
              const readyBonus = video.readyState >= 2 ? 50000 : 0
              bestScore = Math.max(bestScore, area + playingBonus + readyBonus)
            }

            return {
              score: bestScore,
              title: document.title || location.hostname,
              href: location.href,
            }
          },
        })
      } catch {
        return
      }

      for (const entry of frameResults) {
        if (!entry?.result || entry.frameId == null) {
          continue
        }

        results.push({
          tabId: tab.id,
          frameId: entry.frameId,
          score: entry.result.score || 0,
          title: entry.result.title || tab.title,
          href: entry.result.href || tab.url,
        })
      }
    }),
  )

  results.sort((a, b) => b.score - a.score)
  return results
}

async function sendToMovieFrame(message) {
  if (!movieTabId) {
    return
  }

  try {
    await chrome.tabs.sendMessage(movieTabId, message, { frameId: movieFrameId })
  } catch {
    // Frame may have navigated; retry after reinject.
    await ensureContentScripts(movieTabId)
    try {
      await chrome.tabs.sendMessage(movieTabId, message, { frameId: movieFrameId })
    } catch {
      // Give up quietly.
    }
  }
}

async function startMovieCaptureFromBella(senderTabId) {
  bellaTabId = senderTabId ?? null
  const candidates = await probeTabsForVideo()
  const best =
    candidates.find((entry) => entry.tabId !== bellaTabId) ||
    candidates.find((entry) => !String(entry.href || '').includes('localhost:5173')) ||
    candidates[0]

  if (!best) {
    if (bellaTabId) {
      await chrome.tabs.sendMessage(bellaTabId, {
        source: 'bella-stream',
        type: 'movie-capture-status',
        ok: false,
        reason:
          'No playable <video> found. Open the movie site, press play, then try Share movie only again.',
      }).catch(() => undefined)
    }
    return { ok: false }
  }

  movieTabId = best.tabId
  movieFrameId = best.frameId ?? 0

  await ensureContentScripts(movieTabId)

  let started = null
  try {
    started = await chrome.tabs.sendMessage(
      movieTabId,
      {
        source: 'bella-stream',
        type: 'start-movie-capture',
      },
      { frameId: movieFrameId },
    )
  } catch (error) {
    started = { ok: false, reason: String(error) }
  }

  if (bellaTabId) {
    await chrome.tabs.sendMessage(bellaTabId, {
      source: 'bella-stream',
      type: 'movie-capture-status',
      ok: Boolean(started?.ok),
      reason: started?.reason,
      label: best.title,
    }).catch(() => undefined)
  }

  return started
}

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== 'bella-stream') {
    sendResponse({ ok: false })
    return false
  }

  if (message.type === 'share-control' && (message.action === 'play' || message.action === 'pause')) {
    broadcastShareControl(message.action)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (message.type === 'ping') {
    sendResponse({ ok: true, extension: 'bella-stream-control' })
    return false
  }

  sendResponse({ ok: false })
  return false
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== 'bella-stream') {
    return false
  }

  if (message.type === 'share-control' && (message.action === 'play' || message.action === 'pause')) {
    broadcastShareControl(message.action)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (message.type === 'request-movie-capture') {
    bellaTabId = sender.tab?.id ?? bellaTabId
    startMovieCaptureFromBella(bellaTabId)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (message.type === 'movie-capture-signal') {
    // From movie frame → Bella app tab
    if (bellaTabId) {
      chrome.tabs.sendMessage(bellaTabId, {
        source: 'bella-stream',
        type: 'movie-capture-signal',
        payload: message.payload,
      }).catch(() => undefined)
    }
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'movie-capture-signal-from-app') {
    // From Bella app → movie frame (must target the iframe that owns the <video>)
    void sendToMovieFrame({
      source: 'bella-stream',
      type: 'movie-capture-signal',
      payload: message.payload,
    })
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'stop-movie-capture') {
    void sendToMovieFrame({
      source: 'bella-stream',
      type: 'stop-movie-capture',
    })
    movieTabId = null
    movieFrameId = 0
    sendResponse({ ok: true })
    return false
  }

  return false
})
