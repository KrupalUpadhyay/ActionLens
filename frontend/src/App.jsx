import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarPlus, Check, Copy, CreditCard, Mail, ScanLine, ShieldCheck,
  Signal, Sparkles, Wifi, X,
} from 'lucide-react'

const EMPTY = { detected: false, category: 'NONE', data: { title: '', value: '', date: '', email: '' }, bounding_box: [0, 0, 0, 0] }
const WS_URL = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:8000/ws/stream`

function makeCalendarFile(item) {
  const escape = (text) => String(text || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
  const parsed = new Date(item.date)
  const start = Number.isNaN(parsed.getTime()) ? new Date(Date.now() + 60 * 60 * 1000) : parsed
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ActionLens//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${crypto.randomUUID()}@actionlens`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${escape(item.title || 'Event')}`,
    `DESCRIPTION:${escape(item.value)}`, 'END:VEVENT', 'END:VCALENDAR',
  ]
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${(item.title || 'actionlens-event').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.ics`
  anchor.click()
  URL.revokeObjectURL(url)
}

function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const socketRef = useRef(null)
  const streamRef = useRef(null)
  const retryTimer = useRef(null)
  const scanTimerRef = useRef(null)
  const scanEndsAtRef = useRef(0)
  const requestPendingRef = useRef(false)
  const [cameraError, setCameraError] = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const [socketOpen, setSocketOpen] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanSecondsLeft, setScanSecondsLeft] = useState(0)
  const [extractedData, setExtractedData] = useState(EMPTY)
  const [notice, setNotice] = useState('')

  const showNotice = useCallback((message) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2200)
  }, [])

  const stopScan = useCallback(() => {
    window.clearInterval(scanTimerRef.current)
    scanTimerRef.current = null
    scanEndsAtRef.current = 0
    setScanning(false)
    setScanSecondsLeft(0)
    setExtracting(false)
  }, [])

  const requestCamera = useCallback(async () => {
    setCameraError('')
    setCameraReady(false)
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      setCameraError('Camera access requires HTTPS on an external browser. Open the secure https:// site instead of a local network address.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser does not provide camera access. Open ActionLens in a current browser over HTTPS.')
      return
    }
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
    } catch (error) {
      setCameraReady(false)
      const messages = {
        NotAllowedError: 'Camera permission is blocked. Allow camera access for this site in your browser settings, then tap Enable camera.',
        NotFoundError: 'No camera was found on this device.',
        NotReadableError: 'The camera is already in use by another app. Close that app and retry.',
      }
      setCameraError(messages[error.name] || 'Could not start the camera. Check browser permissions and try again.')
    }
  }, [])

  useEffect(() => {
    requestCamera()
    return () => {
      window.clearInterval(scanTimerRef.current)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [requestCamera])

  useEffect(() => {
    let disposed = false
    let retryDelay = 1000
    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(WS_URL)
      socketRef.current = socket
      socket.onopen = () => { retryDelay = 1000; setSocketOpen(true) }
      socket.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data)
          requestPendingRef.current = false
          if (response.busy) { setExtracting(false); return }
          if (response.error) { stopScan(); showNotice(response.error); return }
          if (typeof response.detected === 'boolean' && response.data) {
            setExtractedData(response)
            setExtracting(false)
            if (response.detected) stopScan()
          }
        } catch { showNotice('The server returned an unreadable response.') }
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        setSocketOpen(false)
        requestPendingRef.current = false
        stopScan()
        if (!disposed) {
          retryTimer.current = window.setTimeout(connect, retryDelay)
          retryDelay = Math.min(retryDelay * 1.7, 10000)
        }
      }
    }
    connect()
    return () => {
      disposed = true
      window.clearTimeout(retryTimer.current)
      socketRef.current?.close()
    }
  }, [showNotice, stopScan])

  const sendFrame = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const socket = socketRef.current
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || socket?.readyState !== WebSocket.OPEN || requestPendingRef.current) return
    const maxWidth = 960
    const scale = Math.min(1, maxWidth / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const context = canvas.getContext('2d', { alpha: false })
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const image = canvas.toDataURL('image/jpeg', 0.72)
    if (image.length >= 1_500_000) {
      return
    }
    requestPendingRef.current = true
    setExtracting(true)
    socket.send(JSON.stringify({ image }))
  }, [])

  const scanNow = useCallback(() => {
    if (scanning) {
      stopScan()
      return
    }
    const video = videoRef.current
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      showNotice('Camera is not ready. Enable camera access and try again.')
      return
    }
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      showNotice('Backend is not connected yet')
      return
    }
    setExtractedData(EMPTY)
    setScanning(true)
    setExtracting(false)
    setScanSecondsLeft(8)
    scanEndsAtRef.current = Date.now() + 8000
    sendFrame()
    scanTimerRef.current = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((scanEndsAtRef.current - Date.now()) / 1000))
      setScanSecondsLeft(remaining)
      if (remaining <= 0) {
        stopScan()
        return
      }
      if (remaining % 2 === 0) sendFrame()
    }, 1000)
  }, [scanning, sendFrame, showNotice, stopScan])

  const item = extractedData.data || EMPTY.data
  const action = async () => {
    try {
      switch (extractedData.category) {
        case 'WIFI':
          await navigator.clipboard.writeText(item.value)
          showNotice('Password copied')
          break
        case 'EVENT':
          makeCalendarFile(item)
          showNotice('Calendar file downloaded')
          break
        case 'CONTACT':
          await navigator.clipboard.writeText(item.email || item.value)
          showNotice(item.email ? 'Email copied' : 'Phone number copied')
          break
        case 'RECEIPT':
          {
            const saved = JSON.parse(localStorage.getItem('actionlens.expenses') || '[]')
            saved.push({ amount: item.value, merchant: item.title, loggedAt: new Date().toISOString() })
            localStorage.setItem('actionlens.expenses', JSON.stringify(saved.slice(-100)))
            showNotice(`Expense logged: ${item.value}`)
          }
          break
        case 'TRACKING':
          await navigator.clipboard.writeText(item.value)
          showNotice('Tracking number copied')
          break
        default:
          break
      }
    } catch {
      showNotice('Action unavailable. Check browser permissions and try again.')
    }
  }

  const actionInfo = {
    WIFI: { icon: Wifi, label: 'Copy password', detail: 'Wi-Fi network detected' },
    EVENT: { icon: CalendarPlus, label: 'Add to calendar', detail: 'Event detected' },
    CONTACT: {
      icon: Mail,
      label: item.email ? 'Copy email' : 'Copy phone number',
      detail: item.email ? 'Email detected' : 'Phone number detected',
    },
    RECEIPT: { icon: CreditCard, label: `Log expense · ${item.value || 'amount'}`, detail: 'Receipt detected' },
    TRACKING: { icon: Copy, label: 'Copy tracking number', detail: 'Tracking number detected' },
  }[extractedData.category]
  const ActionIcon = actionInfo?.icon
  const box = extractedData.bounding_box || [0, 0, 0, 0]
  const hasBox = extractedData.detected && box.length === 4 && box.some((value) => value > 0)
  const scanTargets = [
    { icon: Wifi, label: 'Wi-Fi' },
    { icon: CalendarPlus, label: 'Events' },
    { icon: Mail, label: 'Contacts' },
    { icon: CreditCard, label: 'Receipts' },
    { icon: Copy, label: 'Tracking' },
  ]

  return (
    <main className="relative h-[100dvh] min-h-[520px] w-full overflow-hidden bg-[#080b12] text-white">
      <video ref={videoRef} autoPlay muted playsInline onLoadedData={() => setCameraReady(true)} className="absolute inset-0 h-full w-full object-cover" />
      <canvas ref={canvasRef} className="hidden" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_25%,rgba(4,9,15,.22)_72%,rgba(4,9,15,.68)_100%)]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#07101a]/70 via-transparent to-[#07101a]/90" />

      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 pt-[max(1.15rem,env(safe-area-inset-top))] sm:px-8">
        <div className="flex items-center gap-3 rounded-[20px] border border-white/10 bg-[#07111b]/40 py-2 pl-2 pr-4 shadow-lg shadow-black/10 backdrop-blur-xl">
          <div className="grid h-10 w-10 place-items-center rounded-[14px] bg-gradient-to-br from-cyan-200/20 to-emerald-200/10 ring-1 ring-inset ring-cyan-100/25"><ScanLine size={20} className="text-cyan-200" /></div>
          <div><div className="text-sm font-semibold tracking-wide">ActionLens</div><div className="mt-0.5 text-[10px] tracking-[.12em] text-white/55">SEE IT. DO IT.</div></div>
        </div>
        <div className="flex items-center gap-2.5 rounded-full border border-white/15 bg-[#07111b]/55 px-3.5 py-2.5 text-xs font-medium text-white/85 shadow-lg shadow-black/10 backdrop-blur-xl">
          <span className={`relative flex h-2.5 w-2.5 rounded-full ${cameraReady && socketOpen ? 'bg-emerald-400 shadow-[0_0_12px_#34d399]' : 'bg-amber-300'}`}>
            {cameraReady && socketOpen ? <span className="absolute inset-0 animate-ping rounded-full bg-emerald-300 opacity-35" /> : null}
          </span>
          {cameraReady && socketOpen ? <><Signal size={14} className="text-emerald-200" /> Ready</> : !cameraReady ? 'Camera setup' : 'Connecting'}
        </div>
      </header>

      <div className="pointer-events-none absolute inset-0 z-[1] grid place-items-center">
        {hasBox ? <div className="absolute rounded-xl border-2 border-cyan-300/90 shadow-[0_0_28px_#22d3ee55]" style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${Math.max(3, (box[2] - box[0]) * 100)}%`, height: `${Math.max(3, (box[3] - box[1]) * 100)}%` }} /> : null}
        <div className={`scan-frame relative h-[min(38vh,310px)] min-h-[180px] w-[min(76vw,340px)] -translate-y-[12vh] rounded-[30px] border border-white/10 sm:-translate-y-[7vh] ${scanning ? 'scan-frame-active' : ''}`}>
          <div className="absolute inset-3 rounded-[24px] border border-white/[.07]" />
          <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[.19em] text-white/55 backdrop-blur-sm"><span className={`h-1.5 w-1.5 rounded-full ${scanning ? 'animate-pulse bg-cyan-200' : 'bg-white/40'}`} />{scanning ? 'Scanning' : 'Camera view'}</div>
          <span className="absolute left-0 top-0 h-10 w-10 rounded-tl-[26px] border-l-[3px] border-t-[3px] border-cyan-200 shadow-[-3px_-3px_18px_#67e8f955]" />
          <span className="absolute right-0 top-0 h-10 w-10 rounded-tr-[26px] border-r-[3px] border-t-[3px] border-cyan-200 shadow-[3px_-3px_18px_#67e8f955]" />
          <span className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-[26px] border-b-[3px] border-l-[3px] border-cyan-200 shadow-[-3px_3px_18px_#67e8f955]" />
          <span className="absolute bottom-0 right-0 h-10 w-10 rounded-br-[26px] border-b-[3px] border-r-[3px] border-cyan-200 shadow-[3px_3px_18px_#67e8f955]" />
          <div className={`scan-beam absolute inset-x-5 h-px bg-gradient-to-r from-transparent via-cyan-200 to-transparent ${scanning ? 'scan-beam-moving' : 'top-1/2 opacity-30'}`} />
          <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-[#07111b]/35 p-3 backdrop-blur-sm ${extracting ? 'animate-pulse text-cyan-200' : 'text-white/75'}`}><Sparkles size={19} /></div>
          <div className="absolute inset-x-0 bottom-4 text-center text-[10px] font-medium tracking-[.12em] text-white/50">ALIGN TEXT OR AN OBJECT</div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
        <div className="mx-auto flex max-w-md flex-col gap-2.5 rounded-[26px] border border-white/15 bg-[#08121d]/75 p-3 shadow-[0_24px_80px_rgba(0,0,0,.48)] backdrop-blur-2xl sm:gap-3 sm:p-3.5">
          {cameraError ? <div className="w-full rounded-2xl border border-rose-300/20 bg-rose-950/70 p-4 text-sm text-rose-100"><div className="flex items-start gap-2"><X size={18} className="mt-0.5 shrink-0" /><span>{cameraError}</span></div>{!cameraError.includes('requires HTTPS') ? <button onClick={requestCamera} className="mt-3 w-full rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 font-semibold text-white hover:bg-white/15">Enable camera</button> : null}</div> : null}

          {actionInfo && extractedData.detected ? (
            <section className="w-full animate-[rise_.25s_ease-out] rounded-3xl border border-white/10 bg-white/[.06] p-3.5 sm:p-4">
              <div className="mb-3 flex items-center gap-3">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-200"><ShieldCheck size={20} /></div>
                <div className="min-w-0 flex-1"><div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.17em] text-cyan-200"><Sparkles size={12} />{actionInfo.detail}</div><div className="mt-1 truncate text-base font-semibold">{item.title || item.email || item.value || 'Ready to act'}</div></div>
                <button aria-label="Dismiss result" onClick={() => setExtractedData(EMPTY)} className="rounded-full p-2 text-white/50 transition hover:bg-white/10 hover:text-white"><X size={17} /></button>
              </div>
              <button onClick={action} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-200 to-teal-200 px-4 py-3.5 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-950/20 transition hover:brightness-105 active:scale-[.99]"><ActionIcon size={17} />{actionInfo.label}</button>
            </section>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div><div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.18em] text-cyan-200"><span className={`h-1.5 w-1.5 rounded-full ${scanning ? 'animate-pulse bg-cyan-200' : 'bg-emerald-300'}`} />{scanning ? 'Hold steady' : 'Ready to explore'}</div><h1 className="mt-1 text-base font-semibold tracking-tight text-white">{extracting ? 'Finding the useful bits…' : scanning ? 'Looking for an action' : 'What can ActionLens find?'}</h1></div>
                <div className="shrink-0 rounded-lg border border-white/10 bg-white/[.06] px-2 py-1 text-[9px] font-semibold tracking-wide text-white/65"><span className="text-cyan-200">{scanning ? `${scanSecondsLeft}s` : '8 SEC'}</span><span className="ml-1">SCAN</span></div>
              </div>
              <p className="-mt-1 text-[11px] leading-snug text-white/55">{scanning ? 'Keep the item inside the frame as it scans.' : 'Point at a label, flyer, receipt, or card.'}</p>
              <div className="scan-targets flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Supported objects">
                {scanTargets.map(({ icon: Icon, label }) => <div key={label} className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[.045] px-2 py-1 text-[9px] font-medium text-white/70"><Icon size={11} className="text-cyan-200/80" />{label}</div>)}
              </div>
            </>
          )}

          {scanning ? <div className="scan-progress-track"><div className="scan-progress-value" style={{ width: `${((8 - scanSecondsLeft) / 8) * 100}%` }} /></div> : null}
          {!cameraError ? <button onClick={scanNow} disabled={!scanning && (!socketOpen || !cameraReady)} className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-[13px] font-bold text-slate-950 transition active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-45 ${scanning ? 'border border-white/15 bg-white/10 text-white hover:bg-white/15' : 'bg-gradient-to-r from-cyan-200 via-cyan-200 to-teal-200 shadow-[0_8px_30px_rgba(34,211,238,.18)] hover:brightness-105'}`}>
            {scanning ? <X size={16} /> : <ScanLine size={18} />}{scanning ? `Stop scan · ${scanSecondsLeft}s` : extractedData.detected ? 'Scan another item' : 'Scan now'}
          </button> : null}
          <div className="flex items-center justify-center gap-1 text-[9px] tracking-wide text-white/45"><ShieldCheck size={11} className="text-emerald-200/70" />{scanning ? 'Up to 4 frames · stops in 8 seconds' : 'Images sent only when you start scanning'}</div>
        </div>
      </div>

      {notice ? <div role="status" className="absolute left-1/2 top-24 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-white/15 bg-slate-900/90 px-4 py-2.5 text-sm shadow-xl backdrop-blur-xl"><Check size={16} className="text-emerald-300" />{notice}</div> : null}
    </main>
  )
}

export default App
