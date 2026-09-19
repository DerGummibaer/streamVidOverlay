import { useState, useEffect, useRef, useCallback } from 'react'

const MOD_PASSWORD = 'streammod2024'
const FIREBASE_URL = 'https://overlay-7162f-default-rtdb.europe-west1.firebasedatabase.app'

function parseYouTubeId(url) {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

function detectType(url) {
  if (!url) return null
  if (parseYouTubeId(url) || /\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i.test(url)) return 'video'
  if (/\.(jpe?g|png|gif|webp|svg|avif|bmp|tiff?)(\?|$)/i.test(url)) return 'image'
  return null
}

function parseTimestamp(str) {
  if (!str || !str.trim()) return 0
  const parts = str.trim().split(':').map(Number)
  if (parts.some(isNaN)) return 0
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

async function fbGet(path = '') {
  const res = await fetch(`${FIREBASE_URL}${path}.json`)
  if (!res.ok) throw new Error('Firebase read failed')
  return await res.json()
}

async function fbSet(path, data) {
  const res = await fetch(`${FIREBASE_URL}${path}.json`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Firebase write failed')
}

async function fbPush(path, data) {
  const res = await fetch(`${FIREBASE_URL}${path}.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Firebase push failed')
  return await res.json()
}

async function fbDelete(path) {
  await fetch(`${FIREBASE_URL}${path}.json`, { method: 'DELETE' })
}

// ─── Single overlay item ───────────────────────────────────────────────────────
function OverlayItem({ item, onEnded }) {
  const iframeRef = useRef(null)
  const ytId = parseYouTubeId(item.url)
  const startSecs = item.startAt || 0
  const endSecs = item.endAt || 0

  // Ad blocking
  useEffect(() => {
    if (item.type !== 'video' || !ytId) return
    const tryBlock = () => {
      try {
        const doc = iframeRef.current?.contentDocument || iframeRef.current?.contentWindow?.document
        if (!doc) return
        const skip = doc.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')
        if (skip) skip.click()
        const adVid = doc.querySelector('.ad-showing video')
        if (adVid) { adVid.muted = true; if (adVid.duration) adVid.currentTime = adVid.duration }
        doc.querySelectorAll('.ytp-ad-player-overlay-layout, .ytp-ad-player-overlay, .ytp-ad-text-overlay').forEach(el => el.remove())
        const player = doc.getElementById('movie_player')
        if (player?.getAdState?.() !== -1) { try { player.seekTo?.(player.getDuration?.()); player.playVideo?.() } catch (_) {} }
      } catch (_) {}
    }
    const id = setInterval(tryBlock, 100)
    return () => clearInterval(id)
  }, [item.id, ytId])

  // YouTube ended
  useEffect(() => {
    const handler = (e) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
        if ((data?.event === 'onStateChange' && data?.info === 0) ||
            (data?.event === 'infoDelivery' && data?.info?.playerState === 0)) {
          if (!item.loop) onEnded(item.id)
        }
      } catch (_) {}
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [item.id, item.loop, onEnded])

  const boxStyle = {
    position: 'absolute',
    left: `${item.boxX}%`, top: `${item.boxY}%`,
    width: `${item.boxW}%`, height: `${item.boxH}%`,
    overflow: 'hidden', background: 'transparent',
  }

  return (
    <div style={boxStyle}>
      {item.type === 'image' && (
        <img src={item.url} alt=""
          style={{ width: '100%', height: '100%', objectFit: item.fit || 'contain', background: 'transparent' }} />
      )}
      {item.type === 'video' && ytId && (
        <div style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
          <iframe ref={iframeRef}
            src={`https://www.youtube.com/embed/${ytId}?autoplay=1&loop=${item.loop ? 1 : 0}&playlist=${ytId}&enablejsapi=1&start=${startSecs}${endSecs > 0 ? `&end=${endSecs}` : ''}&origin=${encodeURIComponent(window.location.origin)}&rel=0`}
            allow="autoplay; fullscreen"
            style={{ width: '100%', height: 'calc(100% + 80px)', border: 'none', marginBottom: '-80px' }} />
        </div>
      )}
      {item.type === 'video' && !ytId && (
        <video src={item.url} autoPlay loop={item.loop}
          onEnded={() => { if (!item.loop) onEnded(item.id) }}
          onLoadedMetadata={e => { if (startSecs > 0) e.target.currentTime = startSecs }}
          onTimeUpdate={e => { if (endSecs > 0 && e.target.currentTime >= endSecs) { e.target.pause(); if (!item.loop) onEnded(item.id) } }}
          style={{ width: '100%', height: '100%', objectFit: item.fit || 'contain', background: 'transparent' }} />
      )}
    </div>
  )
}

// ─── Overlay ──────────────────────────────────────────────────────────────────
function Overlay() {
  const [items, setItems] = useState({})
  const lastTs = useRef({})

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fbGet('/items')
        if (!data) { setItems({}); return }
        // Only update items that have changed
        setItems(prev => {
          const next = { ...prev }
          let changed = false
          // Add/update
          for (const [id, item] of Object.entries(data)) {
            if (!prev[id] || prev[id].timestamp !== item.timestamp) {
              next[id] = item; changed = true
            }
          }
          // Remove deleted
          for (const id of Object.keys(prev)) {
            if (!data[id]) { delete next[id]; changed = true }
          }
          return changed ? next : prev
        })
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 800)
    return () => clearInterval(id)
  }, [])

  const handleEnded = useCallback(async (id) => {
    try {
      // Try to play next queue item in this slot
      const queue = await fbGet('/queue')
      const qItems = queue ? Object.entries(queue).sort((a, b) => a[1].addedAt - b[1].addedAt) : []
      await fbDelete(`/items/${id}`)
      if (qItems.length > 0) {
        const [key, next] = qItems[0]
        const newId = genId()
        await fbSet(`/items/${newId}`, { ...next, id: newId, timestamp: Date.now() })
        await fbDelete(`/queue/${key}`)
        await fbPush('/history', { ...next, playedAt: Date.now() })
      }
    } catch (_) {}
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'transparent', position: 'relative', overflow: 'hidden' }}>
      {Object.values(items).map(item => (
        <OverlayItem key={item.id} item={item} onEnded={handleEnded} />
      ))}
    </div>
  )
}

// ─── Draggable/resizable preview box ─────────────────────────────────────────
function PreviewBox({ item, onChange, onRemove, isNew }) {
  const ref = useRef()
  const drag = useRef(null)

  const onMouseDown = (e, mode) => {
    e.preventDefault(); e.stopPropagation()
    const rect = ref.current.parentElement.getBoundingClientRect()
    drag.current = { mode, startX: e.clientX, startY: e.clientY, origBox: { boxX: item.boxX, boxY: item.boxY, boxW: item.boxW, boxH: item.boxH }, parentW: rect.width, parentH: rect.height }
  }

  useEffect(() => {
    const onMove = (e) => {
      if (!drag.current) return
      const { mode, startX, startY, origBox, parentW, parentH } = drag.current
      const dx = (e.clientX - startX) / parentW * 100
      const dy = (e.clientY - startY) / parentH * 100
      let { boxX, boxY, boxW, boxH } = origBox
      if (mode === 'move') {
        boxX = Math.max(0, Math.min(100 - boxW, origBox.boxX + dx))
        boxY = Math.max(0, Math.min(100 - boxH, origBox.boxY + dy))
      } else {
        if (mode.includes('e')) boxW = Math.max(5, Math.min(100 - origBox.boxX, origBox.boxW + dx))
        if (mode.includes('s')) boxH = Math.max(5, Math.min(100 - origBox.boxY, origBox.boxH + dy))
        if (mode.includes('w')) { const nw = Math.max(5, origBox.boxW - dx); boxX = origBox.boxX + origBox.boxW - nw; boxW = nw }
        if (mode.includes('n')) { const nh = Math.max(5, origBox.boxH - dy); boxY = origBox.boxY + origBox.boxH - nh; boxH = nh }
      }
      onChange(item.id, { boxX, boxY, boxW, boxH })
    }
    const onUp = () => { drag.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [item.id, onChange])

  const hs = 10
  const handle = (cursor, mode, style) => (
    <div onMouseDown={e => onMouseDown(e, mode)} style={{ position: 'absolute', cursor, zIndex: 10, ...style }} />
  )

  const color = isNew ? '#22c55e' : '#3b82f6'

  return (
    <div ref={ref} style={{
      position: 'absolute', left: `${item.boxX}%`, top: `${item.boxY}%`,
      width: `${item.boxW}%`, height: `${item.boxH}%`,
      border: `2px solid ${color}`, boxSizing: 'border-box',
      background: `${color}26`,
    }}>
      {/* Remove button */}
      <div onClick={() => onRemove(item.id)} style={{
        position: 'absolute', top: -10, right: -10, width: 20, height: 20,
        background: '#ef4444', borderRadius: '50%', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, color: '#fff', fontWeight: 700, zIndex: 20, lineHeight: 1,
      }}>✕</div>
      {/* Label */}
      <div onMouseDown={e => onMouseDown(e, 'move')} style={{
        position: 'absolute', inset: hs, cursor: 'move',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 2,
      }}>
        <span style={{ fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.6)', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none', userSelect: 'none', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label || item.url?.slice(0, 20) || 'item'}
        </span>
        <span style={{ fontSize: 9, color: '#fff', background: 'rgba(0,0,0,0.4)', padding: '1px 4px', borderRadius: 3, pointerEvents: 'none', userSelect: 'none' }}>
          drag to move
        </span>
      </div>
      {handle('ns-resize', 'n', { top: 0, left: hs, right: hs, height: hs })}
      {handle('ns-resize', 's', { bottom: 0, left: hs, right: hs, height: hs })}
      {handle('ew-resize', 'w', { left: 0, top: hs, bottom: hs, width: hs })}
      {handle('ew-resize', 'e', { right: 0, top: hs, bottom: hs, width: hs })}
      {handle('nwse-resize', 'nw', { top: 0, left: 0, width: hs, height: hs })}
      {handle('nesw-resize', 'ne', { top: 0, right: 0, width: hs, height: hs })}
      {handle('nesw-resize', 'sw', { bottom: 0, left: 0, width: hs, height: hs })}
      {handle('nwse-resize', 'se', { bottom: 0, right: 0, width: hs, height: hs })}
    </div>
  )
}

// ─── Control panel ────────────────────────────────────────────────────────────
function ControlPanel() {
  const [authed, setAuthed] = useState(false)
  const [pw, setPw] = useState('')
  const [modName, setModName] = useState('')
  const [pwErr, setPwErr] = useState('')

  // Form state
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [loop, setLoop] = useState(false)
  const [fit, setFit] = useState('contain')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [urlErr, setUrlErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  // Live state
  const [liveItems, setLiveItems] = useState({})
  const [queue, setQueue] = useState([])
  const [history, setHistory] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [presets, setPresets] = useState([])
  const [presetName, setPresetName] = useState('')
  const [tab, setTab] = useState('send')

  // New item being positioned before sending
  const [pendingItem, setPendingItem] = useState(null)
  const pushTimer = useRef({})

  useEffect(() => {
    const saved = localStorage.getItem('stream-mod-presets')
    if (saved) setPresets(JSON.parse(saved))
    const savedName = localStorage.getItem('stream-mod-name')
    if (savedName) setModName(savedName)
  }, [])

  useEffect(() => {
    if (!authed) return
    const poll = async () => {
      try {
        const [items, q, hist, subs] = await Promise.all([
          fbGet('/items'), fbGet('/queue'), fbGet('/history'), fbGet('/submissions')
        ])
        setLiveItems(items || {})
        setQueue(q ? Object.entries(q).sort((a, b) => a[1].addedAt - b[1].addedAt).map(([k, v]) => ({ key: k, ...v })) : [])
        setHistory(hist ? Object.entries(hist).sort((a, b) => b[1].playedAt - a[1].playedAt).slice(0, 30).map(([k, v]) => ({ key: k, ...v })) : [])
        setSubmissions(subs ? Object.entries(subs).filter(([, v]) => v.status === 'pending').sort((a, b) => a[1].submittedAt - b[1].submittedAt).map(([k, v]) => ({ key: k, ...v })) : [])
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 1500)
    return () => clearInterval(id)
  }, [authed])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const buildItem = (overrides = {}) => ({
    id: genId(),
    url: url.trim(),
    type: detectType(url.trim()),
    label, modName, loop, fit,
    startAt: parseTimestamp(startAt),
    endAt: parseTimestamp(endAt),
    boxX: 25, boxY: 25, boxW: 50, boxH: 50,
    timestamp: Date.now(),
    ...overrides,
  })

  const handlePrepare = () => {
    if (!url.trim()) { setUrlErr('Enter a URL'); return }
    const type = detectType(url.trim())
    if (!type) { setUrlErr('Must be a YouTube link, video or image URL'); return }
    setUrlErr('')
    // Create a pending item to position in the preview
    setPendingItem(buildItem())
  }

  const handleSendNow = async () => {
    if (!pendingItem) { handlePrepare(); return }
    setSaving(true)
    try {
      await fbSet(`/items/${pendingItem.id}`, pendingItem)
      await fbPush('/history', { ...pendingItem, playedAt: Date.now() })
      showToast('Sent to overlay')
      setPendingItem(null)
      setUrl(''); setLabel(''); setStartAt(''); setEndAt(''); setLoop(false)
    } catch { showToast('Firebase error') }
    setSaving(false)
  }

  const handleAddToQueue = async () => {
    if (!url.trim()) { setUrlErr('Enter a URL'); return }
    const type = detectType(url.trim())
    if (!type) { setUrlErr('Must be a YouTube link, video or image URL'); return }
    setUrlErr('')
    setSaving(true)
    try {
      await fbPush('/queue', { ...buildItem(), addedAt: Date.now() })
      showToast('Added to queue')
      // If no live items, play immediately
      const items = await fbGet('/items')
      if (!items || Object.keys(items).length === 0) {
        const q = await fbGet('/queue')
        const qItems = q ? Object.entries(q).sort((a, b) => a[1].addedAt - b[1].addedAt) : []
        if (qItems.length > 0) {
          const [key, next] = qItems[0]
          const newId = genId()
          await fbSet(`/items/${newId}`, { ...next, id: newId, timestamp: Date.now() })
          await fbDelete(`/queue/${key}`)
          await fbPush('/history', { ...next, playedAt: Date.now() })
        }
      }
    } catch { showToast('Firebase error') }
    setSaving(false)
  }

  const handleRemoveItem = async (id) => {
    if (id === pendingItem?.id) { setPendingItem(null); return }
    try { await fbDelete(`/items/${id}`); showToast('Removed') } catch (_) {}
  }

  const handleClearAll = async () => {
    try { await fbDelete('/items'); showToast('All cleared') } catch (_) {}
  }

  const handleBoxChange = useCallback((id, newBox) => {
    if (pendingItem?.id === id) {
      setPendingItem(prev => ({ ...prev, ...newBox }))
      return
    }
    setLiveItems(prev => ({ ...prev, [id]: { ...prev[id], ...newBox } }))
    if (pushTimer.current[id]) clearTimeout(pushTimer.current[id])
    pushTimer.current[id] = setTimeout(async () => {
      try {
        const current = await fbGet(`/items/${id}`)
        if (current) await fbSet(`/items/${id}`, { ...current, ...newBox })
      } catch (_) {}
    }, 150)
  }, [pendingItem])

  const approveSubmission = async (sub) => {
    try {
      await fbSet(`/submissions/${sub.key}`, { ...sub, status: 'approved' })
      const id = genId()
      const item = {
        id, url: sub.url, type: detectType(sub.url) || 'video',
        label: `${sub.submittedBy}'s submission`, modName,
        loop: false, fit: 'contain', startAt: 0, endAt: 0,
        boxX: 25, boxY: 25, boxW: 50, boxH: 50, timestamp: Date.now(),
      }
      await fbSet(`/items/${id}`, item)
      await fbPush('/history', { ...item, playedAt: Date.now() })
      showToast('Approved — now live')
    } catch { showToast('Error approving') }
  }

  const rejectSubmission = async (sub) => {
    try { await fbSet(`/submissions/${sub.key}`, { ...sub, status: 'rejected' }); showToast('Rejected') }
    catch { showToast('Error rejecting') }
  }

  const removeFromQueue = async (key) => {
    try { await fbDelete(`/queue/${key}`); showToast('Removed from queue') } catch (_) {}
  }

  const clearHistory = async () => {
    try { await fbDelete('/history'); setHistory([]); showToast('History cleared') } catch (_) {}
  }

  const savePreset = () => {
    if (!url.trim() || !presetName.trim()) return
    const p = { name: presetName, url, label, loop, fit, startAt, endAt }
    const updated = [...presets.filter(x => x.name !== presetName), p]
    setPresets(updated)
    localStorage.setItem('stream-mod-presets', JSON.stringify(updated))
    setPresetName('')
    showToast('Preset saved')
  }

  const allPreviewItems = {
    ...liveItems,
    ...(pendingItem ? { [pendingItem.id]: pendingItem } : {}),
  }

  const isVideoUrl = url && (parseYouTubeId(url) || /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url))
  const liveCount = Object.keys(liveItems).length

  if (!authed) {
    return (
      <div style={s.loginWrap}>
        <div style={s.loginBox}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🎬</div>
          <h2 style={s.loginTitle}>Mod control panel</h2>
          <p style={s.loginSub}>Enter your name and the mod password</p>
          <input type="text" placeholder="Your name" value={modName}
            onChange={e => setModName(e.target.value)}
            style={{ ...s.input, marginBottom: 8 }} />
          <input type="password" placeholder="Password" value={pw}
            onChange={e => { setPw(e.target.value); setPwErr('') }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              if (!modName.trim()) { setPwErr('Enter your name'); return }
              if (pw === MOD_PASSWORD) { localStorage.setItem('stream-mod-name', modName.trim()); setAuthed(true) }
              else setPwErr('Wrong password')
            }}
            style={{ ...s.input, marginBottom: 8 }} />
          {pwErr && <div style={s.err}>{pwErr}</div>}
          <button style={{ ...s.btn, background: '#3b82f6', width: '100%', marginTop: 8 }} onClick={() => {
            if (!modName.trim()) { setPwErr('Enter your name'); return }
            if (pw === MOD_PASSWORD) { localStorage.setItem('stream-mod-name', modName.trim()); setAuthed(true) }
            else setPwErr('Wrong password')
          }}>Sign in</button>
        </div>
      </div>
    )
  }

  return (
    <div style={s.wrap}>
      {toast && <div style={s.toast}>{toast}</div>}
      <div style={s.inner}>

        <div style={s.header}>
          <div>
            <h1 style={s.h1}>Stream overlay</h1>
            <p style={s.sub}>Signed in as <strong style={{ color: '#cbd5e1' }}>{modName}</strong></p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ ...s.dot, background: liveCount > 0 ? '#22c55e' : '#6b7280' }} />
            <span style={s.sub}>{liveCount > 0 ? `${liveCount} live item${liveCount > 1 ? 's' : ''}` : 'No overlay'}</span>
            {liveCount > 0 && <button style={{ ...s.smBtn, fontSize: 11 }} onClick={handleClearAll}>Clear all</button>}
          </div>
        </div>

        {/* Stream preview */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ ...s.label, marginBottom: 0 }}>
              Stream preview
              {pendingItem && <span style={{ color: '#22c55e', marginLeft: 8 }}>— position your item, then hit Send</span>}
            </label>
            <span style={{ fontSize: 11, color: '#64748b' }}>{liveCount} live · {queue.length} queued</span>
          </div>
          <div style={{ position: 'relative', width: '100%', paddingBottom: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
            <iframe src="https://player.twitch.tv/?channel=beccahtw&parent=dergummibaer.github.io&parent=localhost&muted=true"
              allowFullScreen style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }} />
            {Object.values(allPreviewItems).map(item => (
              <PreviewBox key={item.id} item={item}
                onChange={handleBoxChange}
                onRemove={handleRemoveItem}
                isNew={item.id === pendingItem?.id} />
            ))}
          </div>
        </div>

        {queue.length > 0 && (
          <div style={{ ...s.liveBar, background: '#1e1b4b', borderColor: '#4f46e5' }}>
            <span style={{ fontSize: 13, color: '#a5b4fc' }}>
              {queue.length} in queue — next: <strong>{queue[0].label || queue[0].url?.slice(0, 40)}</strong>
            </span>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {['send', 'queue', 'history', 'submissions'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              ...s.tabBtn,
              background: tab === t ? '#3b82f6' : 'none',
              color: tab === t ? '#fff' : '#94a3b8',
              borderColor: tab === t ? '#3b82f6' : '#334155',
            }}>
              {t === 'send' ? 'Send'
                : t === 'queue' ? `Queue${queue.length > 0 ? ` (${queue.length})` : ''}`
                : t === 'submissions' ? `Submissions${submissions.length > 0 ? ` (${submissions.length})` : ''}`
                : 'History'}
            </button>
          ))}
        </div>

        {tab === 'send' && (
          <div style={s.card}>
            <label style={s.label}>URL</label>
            <input type="url" placeholder="YouTube, Shorts, .mp4, .jpg, .png, .gif…"
              value={url} onChange={e => { setUrl(e.target.value); setUrlErr(''); setPendingItem(null) }}
              style={{ ...s.input, marginBottom: urlErr ? 4 : 12 }} />
            {urlErr && <div style={{ ...s.err, marginBottom: 8 }}>{urlErr}</div>}

            <label style={s.label}>Label (optional)</label>
            <input type="text" placeholder="e.g. Jumpscare, raid gif…"
              value={label} onChange={e => setLabel(e.target.value)}
              style={{ ...s.input, marginBottom: 12 }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={s.label}>Fit</label>
                <select value={fit} onChange={e => setFit(e.target.value)} style={s.select}>
                  <option value="contain">Contain (letterbox)</option>
                  <option value="cover">Cover (fill)</option>
                  <option value="fill">Stretch</option>
                </select>
              </div>
            </div>

            {isVideoUrl && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={s.label}>Start at</label>
                  <input type="text" placeholder="e.g. 1:23" value={startAt}
                    onChange={e => setStartAt(e.target.value)} style={s.input} />
                </div>
                <div>
                  <label style={s.label}>End at</label>
                  <input type="text" placeholder="e.g. 2:45" value={endAt}
                    onChange={e => setEndAt(e.target.value)} style={s.input} />
                </div>
              </div>
            )}

            {isVideoUrl && (
              <label style={{ ...s.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16 }}>
                <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
                Loop video
              </label>
            )}

            {!pendingItem ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button style={{ ...s.btn, background: '#3b82f6' }} onClick={handlePrepare}>
                  Position in preview →
                </button>
                <button style={{ ...s.btn, background: '#4f46e5' }} onClick={handleAddToQueue} disabled={saving}>
                  + Add to queue
                </button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button style={{ ...s.btn, background: '#22c55e' }} onClick={handleSendNow} disabled={saving}>
                  {saving ? 'Sending…' : '▶ Send now'}
                </button>
                <button style={{ ...s.btn, background: '#6b7280' }} onClick={() => setPendingItem(null)}>
                  Cancel
                </button>
              </div>
            )}

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #334155' }}>
              <h3 style={{ ...s.h3, marginBottom: 10 }}>Presets</h3>
              {presets.length === 0 && <p style={{ ...s.sub, marginBottom: 10 }}>No presets yet.</p>}
              {presets.map(p => (
                <div key={p.name} style={s.presetRow}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={s.smBtn} onClick={() => {
                      setUrl(p.url); setLabel(p.label || ''); setLoop(p.loop || false)
                      setFit(p.fit || 'contain'); setStartAt(p.startAt || ''); setEndAt(p.endAt || '')
                      setPendingItem(null)
                    }}>Load</button>
                    <button style={{ ...s.smBtn, color: '#ef4444', borderColor: '#fca5a5' }}
                      onClick={() => { const u = presets.filter(x => x.name !== p.name); setPresets(u); localStorage.setItem('stream-mod-presets', JSON.stringify(u)) }}>✕</button>
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="text" placeholder="Preset name…" value={presetName}
                  onChange={e => setPresetName(e.target.value)}
                  style={{ ...s.input, flex: 1, marginBottom: 0 }} />
                <button style={{ ...s.btn, background: '#3b82f6' }} onClick={savePreset}>Save</button>
              </div>
            </div>
          </div>
        )}

        {tab === 'queue' && (
          <div style={s.card}>
            <h3 style={s.h3}>Queue</h3>
            {queue.length === 0 && <p style={s.sub}>Queue is empty.</p>}
            {queue.map((item, i) => (
              <div key={item.key} style={s.presetRow}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 12, color: '#64748b', marginRight: 8 }}>#{i + 1}</span>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{item.label || item.url?.slice(0, 45)}</span>
                  <span style={{ fontSize: 12, color: '#64748b', marginLeft: 8 }}>{item.modName}</span>
                </div>
                <button style={{ ...s.smBtn, color: '#ef4444', borderColor: '#fca5a5' }}
                  onClick={() => removeFromQueue(item.key)}>✕</button>
              </div>
            ))}
          </div>
        )}

        {tab === 'history' && (
          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ ...s.h3, marginBottom: 0 }}>History</h3>
              {history.length > 0 && <button style={s.smBtn} onClick={clearHistory}>Clear all</button>}
            </div>
            {history.length === 0 && <p style={s.sub}>Nothing played yet.</p>}
            {history.map(item => (
              <div key={item.key} style={s.presetRow}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{item.label || item.url?.slice(0, 45)}</span>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    {item.modName} · {formatTime(item.playedAt)} · {item.type}
                  </div>
                </div>
                <button style={s.smBtn} onClick={() => {
                  setUrl(item.url || ''); setLabel(item.label || ''); setLoop(item.loop || false)
                  setFit(item.fit || 'contain'); setTab('send'); setPendingItem(null)
                }}>Reuse</button>
              </div>
            ))}
          </div>
        )}

        {tab === 'submissions' && (
          <div style={s.card}>
            <h3 style={s.h3}>Viewer Submissions</h3>
            {submissions.length === 0 && <p style={s.sub}>No pending submissions.</p>}
            {submissions.map(sub => (
              <div key={sub.key} style={{ ...s.presetRow, flexDirection: 'column', alignItems: 'flex-start', gap: 8, paddingBottom: 12 }}>
                <div style={{ width: '100%' }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#f1f5f9' }}>{sub.submittedBy}</span>
                  <span style={{ fontSize: 12, color: '#64748b', marginLeft: 8 }}>{formatTime(sub.submittedAt)}</span>
                  <div style={{ marginTop: 4 }}>
                    <a href={sub.url} target="_blank" rel="noreferrer"
                      style={{ fontSize: 12, color: '#60a5fa', wordBreak: 'break-all' }}>
                      {sub.url.slice(0, 60)}{sub.url.length > 60 ? '…' : ''}
                    </a>
                  </div>
                </div>
                {parseYouTubeId(sub.url) && (
                  <img src={`https://img.youtube.com/vi/${parseYouTubeId(sub.url)}/mqdefault.jpg`}
                    alt="thumbnail" style={{ width: '100%', maxWidth: 240, borderRadius: 6 }} />
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{ ...s.btn, background: '#16a34a', padding: '6px 16px', fontSize: 13 }}
                    onClick={() => approveSubmission(sub)}>✅ Approve</button>
                  <button style={{ ...s.btn, background: '#dc2626', padding: '6px 16px', fontSize: 13 }}
                    onClick={() => rejectSubmission(sub)}>❌ Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', marginTop: 8 }}
          onClick={() => setAuthed(false)}>Sign out</button>
      </div>
    </div>
  )
}

const s = {
  loginWrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', fontFamily: 'system-ui, sans-serif' },
  loginBox: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '2rem 2.5rem', width: 340, textAlign: 'center', color: '#f1f5f9' },
  loginTitle: { margin: '0 0 4px', fontSize: 18, fontWeight: 500, color: '#f1f5f9' },
  loginSub: { margin: '0 0 1.25rem', fontSize: 13, color: '#94a3b8' },
  wrap: { minHeight: '100vh', background: '#0f172a', padding: '1.5rem', boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif', color: '#f1f5f9' },
  inner: { maxWidth: 700, margin: '0 auto' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' },
  h1: { margin: 0, fontSize: 20, fontWeight: 500, color: '#f1f5f9' },
  h3: { margin: '0 0 12px', fontSize: 15, fontWeight: 500, color: '#f1f5f9' },
  sub: { margin: '2px 0 0', fontSize: 13, color: '#94a3b8' },
  dot: { width: 8, height: 8, borderRadius: '50%' },
  card: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '1.25rem', marginBottom: '1rem' },
  label: { fontSize: 13, color: '#94a3b8', display: 'block', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', color: '#f1f5f9', fontSize: 14, outline: 'none', marginBottom: 0 },
  select: { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', color: '#f1f5f9', fontSize: 14 },
  btn: { border: 'none', borderRadius: 6, padding: '9px 18px', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  tabBtn: { border: '1px solid', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer' },
  smBtn: { background: 'none', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', color: '#cbd5e1', fontSize: 12, cursor: 'pointer' },
  clearBtn: { background: 'none', border: '1px solid #fca5a5', borderRadius: 6, padding: '4px 12px', color: '#ef4444', fontSize: 13, cursor: 'pointer', flexShrink: 0 },
  err: { fontSize: 13, color: '#ef4444', marginBottom: 4 },
  liveBar: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  presetRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1e293b' },
  toast: { position: 'fixed', top: 16, right: 16, background: '#1e293b', border: '1px solid #3b82f6', borderRadius: 8, padding: '10px 16px', fontSize: 14, color: '#60a5fa', zIndex: 999 },
}

export default function App() {
  const [mode, setMode] = useState(null)
  useEffect(() => setMode(window.location.hash === '#overlay' ? 'overlay' : 'control'), [])
  if (!mode) return null
  return mode === 'overlay' ? <Overlay /> : <ControlPanel />
}
