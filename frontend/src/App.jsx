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
  const [cameraError, setCameraError] = useState('')
  const [socketOpen, setSocketOpen] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractedData, setExtractedData] = useState(EMPTY)
  const [notice, setNotice] = useState('')

  const showNotice = useCallback((message) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2200)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Camera access requires a supported browser and a secure connection.')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      } catch (error) {
        setCameraError(error.name === 'NotAllowedError'
          ? 'Allow camera access in your browser to start scanning.'
          : 'Could not start the camera. Check that it is available and try again.')
      }
    }
    startCamera()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

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
          if (response.error) { showNotice(response.error); return }
          if (typeof response.detected === 'boolean' && response.data) {
            setExtractedData(response)
            setExtracting(false)
          }
        } catch { showNotice('The server returned an unreadable response.') }
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        setSocketOpen(false)
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
  }, [showNotice])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const video = videoRef.current
      const canvas = canvasRef.current
      const socket = socketRef.current
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || socket?.readyState !== WebSocket.OPEN) return
      const maxWidth = 960
      const scale = Math.min(1, maxWidth / video.videoWidth)
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      const context = canvas.getContext('2d', { alpha: false })
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = canvas.toDataURL('image/jpeg', 0.72)
      // Keep each frame bounded for reliable mobile uploads and backend memory use.
      if (image.length < 1_500_000 && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ image }))
        setExtracting(true)
      }
    }, 650)
    return () => window.clearInterval(timer)
  }, [])

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
          showNotice('Contact copied')
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
    CONTACT: { icon: Mail, label: 'Copy email', detail: 'Contact detected' },
    RECEIPT: { icon: CreditCard, label: `Log expense · ${item.value || 'amount'}`, detail: 'Receipt detected' },
    TRACKING: { icon: Copy, label: 'Copy tracking number', detail: 'Tracking number detected' },
  }[extractedData.category]
  const ActionIcon = actionInfo?.icon
  const box = extractedData.bounding_box || [0, 0, 0, 0]
  const hasBox = extractedData.detected && box.length === 4 && box.some((value) => value > 0)

  return (
    <main className="relative h-[100dvh] min-h-[520px] w-full overflow-hidden bg-[#080b12] text-white">
      <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />
      <canvas ref={canvasRef} className="hidden" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/65 via-transparent to-black/75" />

      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 pb-8 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl border border-white/15 bg-white/10 backdrop-blur-xl"><ScanLine size={20} className="text-cyan-300" /></div>
          <div><div className="text-sm font-semibold tracking-wide">ActionLens</div><div className="text-[11px] text-white/60">See it. Do it.</div></div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/35 px-3 py-2 text-xs text-white/80 backdrop-blur-xl">
          <span className={`h-2 w-2 rounded-full ${socketOpen ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]' : 'bg-amber-400'}`} />
          {socketOpen ? <><Signal size={14} /> Live</> : 'Connecting'}
        </div>
      </header>

      <div className="pointer-events-none absolute inset-0 z-[1] grid place-items-center">
        {hasBox ? <div className="absolute rounded-xl border-2 border-cyan-300/90 shadow-[0_0_28px_#22d3ee55]" style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${Math.max(3, (box[2] - box[0]) * 100)}%`, height: `${Math.max(3, (box[3] - box[1]) * 100)}%` }} /> : null}
        <div className="relative h-52 w-52 sm:h-64 sm:w-64">
          <span className="absolute left-0 top-0 h-9 w-9 rounded-tl-2xl border-l-2 border-t-2 border-cyan-300/90" />
          <span className="absolute right-0 top-0 h-9 w-9 rounded-tr-2xl border-r-2 border-t-2 border-cyan-300/90" />
          <span className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-2xl border-b-2 border-l-2 border-cyan-300/90" />
          <span className="absolute bottom-0 right-0 h-9 w-9 rounded-br-2xl border-b-2 border-r-2 border-cyan-300/90" />
          <div className="absolute inset-x-4 top-1/2 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
          <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full p-3 ${extracting ? 'animate-pulse text-cyan-300' : 'text-white/70'}`}><Sparkles size={20} /></div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8">
        <div className="mx-auto flex max-w-lg flex-col items-center gap-4">
          {cameraError ? <div className="flex w-full items-start gap-2 rounded-2xl border border-rose-300/20 bg-rose-950/70 p-4 text-sm text-rose-100 backdrop-blur-xl"><X size={18} className="mt-0.5 shrink-0" />{cameraError}</div> : null}
          {actionInfo && extractedData.detected ? (
            <section className="w-full animate-[rise_.25s_ease-out] rounded-3xl border border-white/15 bg-[#101722]/85 p-4 shadow-2xl backdrop-blur-2xl sm:p-5">
              <div className="mb-4 flex items-center gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-200"><ShieldCheck size={19} /></div>
                <div className="min-w-0 flex-1"><div className="text-xs font-medium uppercase tracking-[.16em] text-cyan-200">{actionInfo.detail}</div><div className="mt-1 truncate text-base font-semibold">{item.title || item.email || item.value || 'Ready to act'}</div></div>
                <button aria-label="Dismiss result" onClick={() => setExtractedData(EMPTY)} className="rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white"><X size={17} /></button>
              </div>
              <button onClick={action} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-300 px-4 py-3.5 text-sm font-bold text-slate-950 transition hover:bg-cyan-200 active:scale-[.99]"><ActionIcon size={17} />{actionInfo.label}</button>
            </section>
          ) : (
            <div className="rounded-full border border-white/10 bg-black/40 px-4 py-2.5 text-center text-sm text-white/80 backdrop-blur-xl">
              {cameraError ? 'Camera unavailable' : extracting ? 'Scanning for something actionable…' : 'Point your camera at something useful'}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[11px] tracking-wide text-white/55"><span className={`h-1.5 w-1.5 rounded-full ${socketOpen ? 'bg-emerald-400' : 'bg-amber-300'}`} />Live scan · Frames are processed as you move</div>
        </div>
      </div>

      {notice ? <div role="status" className="absolute left-1/2 top-24 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-white/15 bg-slate-900/90 px-4 py-2.5 text-sm shadow-xl backdrop-blur-xl"><Check size={16} className="text-emerald-300" />{notice}</div> : null}
    </main>
  )
}

export default App
