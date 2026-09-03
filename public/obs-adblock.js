// Paste this into OBS Browser Source > Custom JS field
// It runs in the browser source context and blocks YouTube ads

setInterval(() => {
  const iframes = document.querySelectorAll('iframe')
  iframes.forEach(iframe => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document
      // Skip button
      const skip = doc.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')
      if (skip) skip.click()
      // Fast-forward ad
      const adVid = doc.querySelector('.ad-showing video')
      if (adVid) { adVid.muted = true; if (adVid.duration) adVid.currentTime = adVid.duration }
      // Nuke ad overlay
      const overlay = doc.querySelector('.ytp-ad-player-overlay-layout')
      if (overlay) overlay.remove()
    } catch (_) {}
  })
}, 200)
