'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { enqueueReading, peekQueue, removeFromQueue, queueLength } from '@/lib/capture-db'

// All signal processing happens here, on-device. Nothing raw (no audio
// samples, no video frames) ever leaves this hook - only the computed
// numeric features it enqueues. See PIVOT_AUDIT.md / the Phase 2 plan for
// why this boundary is a hard privacy requirement, not a preference.

const SAMPLE_INTERVAL_MS = 1000 // sound + vibration aggregate, 1 Hz
const LIGHT_SAMPLE_INTERVAL_MS = 3000
const FLUSH_INTERVAL_MS = 20000
const SPECTRUM_BANDS = 8

export type PermissionState = 'idle' | 'granted' | 'denied' | 'unsupported'

export type CaptureStatus = {
  micPermission: PermissionState
  cameraPermission: PermissionState
  motionPermission: PermissionState
  wakeLockActive: boolean
  wakeLockSupported: boolean
  running: boolean
  capturedCount: number
  uploadedCount: number
  bufferedCount: number
  uptimeSeconds: number
  lastFlushError: string | null
  lastSoundLevel: number | null
  lastLightLevel: number | null
}

export function useCaptureLoop(token: string) {
  const [status, setStatus] = useState<CaptureStatus>({
    micPermission: 'idle',
    cameraPermission: 'idle',
    motionPermission: 'idle',
    wakeLockActive: false,
    wakeLockSupported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    running: false,
    capturedCount: 0,
    uploadedCount: 0,
    bufferedCount: 0,
    uptimeSeconds: 0,
    lastFlushError: null,
    lastSoundLevel: null,
    lastLightLevel: null,
  })

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  const soundBaselineRef = useRef(0) // additive offset from an optional quiet-room calibration tap
  const motionSamplesRef = useRef<number[]>([])

  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lightTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const uptimeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushBackoffRef = useRef(1) // multiplies FLUSH_INTERVAL_MS on repeated failure, resets on success

  const requestMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      micStreamRef.current = stream
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      audioCtxRef.current = ctx
      analyserRef.current = analyser
      setStatus((s) => ({ ...s, micPermission: 'granted' }))
      return true
    } catch {
      setStatus((s) => ({ ...s, micPermission: 'denied' }))
      return false
    }
  }, [])

  const requestCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      cameraStreamRef.current = stream
      const video = document.createElement('video')
      video.srcObject = stream
      video.playsInline = true
      video.muted = true
      await video.play()
      videoElRef.current = video
      canvasRef.current = document.createElement('canvas')
      canvasRef.current.width = 32
      canvasRef.current.height = 32
      setStatus((s) => ({ ...s, cameraPermission: 'granted' }))
      return true
    } catch {
      setStatus((s) => ({ ...s, cameraPermission: 'denied' }))
      return false
    }
  }, [])

  const requestMotion = useCallback(async () => {
    const DME = (window as any).DeviceMotionEvent
    if (!DME) {
      setStatus((s) => ({ ...s, motionPermission: 'unsupported' }))
      return false
    }
    try {
      if (typeof DME.requestPermission === 'function') {
        const result = await DME.requestPermission()
        if (result !== 'granted') {
          setStatus((s) => ({ ...s, motionPermission: 'denied' }))
          return false
        }
      }
      window.addEventListener('devicemotion', onDeviceMotion)
      setStatus((s) => ({ ...s, motionPermission: 'granted' }))
      return true
    } catch {
      setStatus((s) => ({ ...s, motionPermission: 'denied' }))
      return false
    }
  }, [])

  const onDeviceMotion = useCallback((event: DeviceMotionEvent) => {
    const a = event.accelerationIncludingGravity || event.acceleration
    if (!a || a.x === null) return
    const magnitude = Math.sqrt((a.x ?? 0) ** 2 + (a.y ?? 0) ** 2 + (a.z ?? 0) ** 2)
    motionSamplesRef.current.push(magnitude)
  }, [])

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return false
    try {
      wakeLockRef.current = await (navigator as any).wakeLock.request('screen')
      setStatus((s) => ({ ...s, wakeLockActive: true }))
      wakeLockRef.current?.addEventListener('release', () => {
        setStatus((s) => ({ ...s, wakeLockActive: false }))
      })
      return true
    } catch {
      setStatus((s) => ({ ...s, wakeLockActive: false }))
      return false
    }
  }, [])

  // Safari releases the wake lock when backgrounded; re-acquire on return.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && status.wakeLockSupported && !wakeLockRef.current) {
        requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [requestWakeLock, status.wakeLockSupported])

  const calibrateQuiet = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const data = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(data)
    soundBaselineRef.current = -rmsToDb(data)
  }, [])

  const sampleSound = useCallback(async () => {
    const analyser = analyserRef.current
    if (!analyser) return
    const timeData = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(timeData)
    const level = rmsToDb(timeData) + soundBaselineRef.current

    const freqData = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(freqData)
    const bands = bandEnergies(freqData, SPECTRUM_BANDS)

    const timestamp = new Date().toISOString()
    await enqueueReading({ signal_type: 'sound_level_dba', timestamp, value: Math.round(level * 10) / 10 })
    await enqueueReading({ signal_type: 'sound_spectrum', timestamp, value: { bands } })
    setStatus((s) => ({ ...s, lastSoundLevel: level, capturedCount: s.capturedCount + 2 }))
  }, [])

  const sampleVibration = useCallback(async () => {
    const samples = motionSamplesRef.current
    motionSamplesRef.current = []
    if (samples.length === 0) return
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
    await enqueueReading({
      signal_type: 'vibration',
      timestamp: new Date().toISOString(),
      value: { mean: round(mean), variance: round(variance) },
    })
    setStatus((s) => ({ ...s, capturedCount: s.capturedCount + 1 }))
  }, [])

  const sampleLight = useCallback(async () => {
    const video = videoElRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    // Clear immediately - the pixel buffer is sampled, never retained or sent.
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    let r = 0, g = 0, b = 0
    const pixelCount = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
    }
    r /= pixelCount
    g /= pixelCount
    b /= pixelCount
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    // Rough proxy only - a real color-temperature estimate needs a
    // calibrated sensor, not a phone camera's auto-white-balanced output.
    // Mapped to a plausible indoor range (2700-6500K) from the R/B ratio.
    const rbRatio = r / Math.max(b, 1)
    const colorTempK = Math.round(clamp(6500 - (rbRatio - 1) * 1500, 2700, 6500))

    const timestamp = new Date().toISOString()
    await enqueueReading({ signal_type: 'light_level', timestamp, value: round(luminance) })
    await enqueueReading({ signal_type: 'light_color_temp', timestamp, value: colorTempK })
    setStatus((s) => ({ ...s, lastLightLevel: luminance, capturedCount: s.capturedCount + 2 }))
  }, [])

  const flush = useCallback(async () => {
    const { keys, readings } = await peekQueue(300)
    if (readings.length === 0) {
      const remaining = await queueLength()
      setStatus((s) => ({ ...s, bufferedCount: remaining }))
      return
    }
    try {
      const res = await fetch(`/api/capture/${token}/readings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readings }),
      })
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      await removeFromQueue(keys)
      flushBackoffRef.current = 1
      const remaining = await queueLength()
      setStatus((s) => ({
        ...s,
        uploadedCount: s.uploadedCount + readings.length,
        bufferedCount: remaining,
        lastFlushError: null,
      }))
    } catch (err: any) {
      // Exponential backoff, capped at 8x the base interval - readings stay
      // queued in IndexedDB, nothing is dropped by a failed flush.
      flushBackoffRef.current = Math.min(flushBackoffRef.current * 2, 8)
      const remaining = await queueLength()
      setStatus((s) => ({ ...s, bufferedCount: remaining, lastFlushError: err.message }))
    }
  }, [token])

  const start = useCallback(async () => {
    setStatus((s) => ({ ...s, running: true }))
    sampleTimerRef.current = setInterval(() => {
      sampleSound()
      sampleVibration()
    }, SAMPLE_INTERVAL_MS)
    lightTimerRef.current = setInterval(sampleLight, LIGHT_SAMPLE_INTERVAL_MS)
    flushTimerRef.current = setInterval(() => flush(), FLUSH_INTERVAL_MS)
    uptimeTimerRef.current = setInterval(() => {
      setStatus((s) => ({ ...s, uptimeSeconds: s.uptimeSeconds + 1 }))
    }, 1000)
  }, [sampleSound, sampleVibration, sampleLight, flush])

  const stop = useCallback(() => {
    ;[sampleTimerRef, lightTimerRef, flushTimerRef, uptimeTimerRef].forEach((ref) => {
      if (ref.current) clearInterval(ref.current)
      ref.current = null
    })
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    audioCtxRef.current?.close()
    window.removeEventListener('devicemotion', onDeviceMotion)
    wakeLockRef.current?.release()
    setStatus((s) => ({ ...s, running: false }))
  }, [onDeviceMotion])

  useEffect(() => () => stop(), [stop])

  return { status, requestMic, requestCamera, requestMotion, requestWakeLock, calibrateQuiet, start, stop, flush }
}

function rmsToDb(timeData: Uint8Array): number {
  let sumSquares = 0
  for (let i = 0; i < timeData.length; i++) {
    const normalized = (timeData[i] - 128) / 128
    sumSquares += normalized * normalized
  }
  const rms = Math.sqrt(sumSquares / timeData.length)
  // Uncalibrated/relative - not true SPL dB(A). See the capture page copy,
  // which labels this explicitly rather than presenting it as measured.
  return clamp(20 * Math.log10(rms + 1e-6) + 90, 0, 120)
}

function bandEnergies(freqData: Uint8Array, bandCount: number): number[] {
  const bands = new Array(bandCount).fill(0)
  const perBand = Math.ceil(freqData.length / bandCount)
  for (let b = 0; b < bandCount; b++) {
    let sum = 0
    let count = 0
    for (let i = b * perBand; i < Math.min((b + 1) * perBand, freqData.length); i++) {
      sum += freqData[i]
      count++
    }
    bands[b] = count > 0 ? round(sum / count) : 0
  }
  return bands
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function round(v: number) {
  return Math.round(v * 100) / 100
}
