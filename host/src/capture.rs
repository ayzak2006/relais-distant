//! Capture d'écran (ScreenCaptureKit, zéro copie en YUV 4:2:0) + encodage H.264
//! matériel VideoToolbox en mode faible latence. Sortie : unités Annex-B prêtes pour WebRTC.

use crate::ffi::*;
use crate::ffi::CMTime as VtTime;
use anyhow::{anyhow, Result};
use bytes::Bytes;
use screencapturekit::prelude::*;
use screencapturekit::stream::configuration::PixelFormat;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug)]
pub struct CaptureParams {
    pub max_width: u32,
    pub fps: u32,
    pub bitrate: i32,
}

/// Géométrie de l'écran capturé, utilisée pour placer la souris.
#[derive(Clone, Copy, Debug)]
pub struct ScreenGeometry {
    pub display_id: u32,
    pub width: u32,
    pub height: u32,
}

/// Pointeur CoreFoundation retenu, transférable entre threads.
struct Retained(*mut c_void);
unsafe impl Send for Retained {}
impl Retained {
    unsafe fn retain(p: *mut c_void) -> Self {
        CFRetain(p as CFTypeRef);
        Self(p)
    }
}
impl Drop for Retained {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) }
    }
}

/// Destination des images encodées (référencée par le callback C de VideoToolbox).
struct Sink {
    tx: mpsc::Sender<Bytes>,
    force_key: AtomicBool,
}

struct Encoder {
    session: VTCompressionSessionRef,
    sink: *const Sink,
    start: Instant,
    state: Mutex<EncState>,
    last_encode_ms: AtomicU64,
}
struct EncState {
    last_frame: Option<Retained>,
    last_pts: i64,
}
unsafe impl Send for Encoder {}
unsafe impl Sync for Encoder {}

impl Encoder {
    fn new(width: i32, height: i32, p: CaptureParams, tx: mpsc::Sender<Bytes>) -> Result<Arc<Self>> {
        let sink = Box::into_raw(Box::new(Sink { tx, force_key: AtomicBool::new(true) }));
        unsafe {
            let spec = cf_dict(&[(kVTVideoEncoderSpecification_EnableLowLatencyRateControl, kCFBooleanTrue)]);
            let mut session: VTCompressionSessionRef = std::ptr::null_mut();
            let st = VTCompressionSessionCreate(
                std::ptr::null(),
                width,
                height,
                kCMVideoCodecType_H264,
                spec,
                std::ptr::null(),
                std::ptr::null(),
                on_encoded,
                sink as *mut c_void,
                &mut session,
            );
            CFRelease(spec);
            if st != 0 || session.is_null() {
                drop(Box::from_raw(sink));
                return Err(anyhow!("VTCompressionSessionCreate a échoué ({st})"));
            }
            let set = |k: CFStringRef, v: CFTypeRef| VTSessionSetProperty(session, k, v);
            set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
            set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
            set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel);
            for (k, v) in [
                (kVTCompressionPropertyKey_AverageBitRate, cf_i32(p.bitrate)),
                (kVTCompressionPropertyKey_ExpectedFrameRate, cf_i32(p.fps as i32)),
                (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, cf_f64(4.0)),
            ] {
                set(k, v);
                CFRelease(v);
            }
            VTCompressionSessionPrepareToEncodeFrames(session);
            Ok(Arc::new(Self {
                session,
                sink,
                start: Instant::now(),
                state: Mutex::new(EncState { last_frame: None, last_pts: -1 }),
                last_encode_ms: AtomicU64::new(0),
            }))
        }
    }

    fn request_keyframe(&self) {
        unsafe { (*self.sink).force_key.store(true, Ordering::Relaxed) }
    }

    /// Encode une image. `frame = None` ré-encode la dernière (écran immobile).
    fn encode(&self, frame: Option<*mut c_void>) {
        let mut st = self.state.lock().unwrap();
        if let Some(pb) = frame {
            st.last_frame = Some(unsafe { Retained::retain(pb) });
        }
        let Some(pb) = st.last_frame.as_ref().map(|r| r.0) else { return };
        let elapsed = self.start.elapsed();
        let pts = (elapsed.as_micros() as i64).max(st.last_pts + 1);
        st.last_pts = pts;
        self.last_encode_ms.store(elapsed.as_millis() as u64, Ordering::Relaxed);
        unsafe {
            let force = (*self.sink).force_key.swap(false, Ordering::Relaxed);
            let props = if force { cf_dict(&[(kVTEncodeFrameOptionKey_ForceKeyFrame, kCFBooleanTrue)]) } else { std::ptr::null() };
            VTCompressionSessionEncodeFrame(self.session, pb, VtTime::new(pts, 1_000_000), VtTime::invalid(), props, std::ptr::null_mut(), std::ptr::null_mut());
            if !props.is_null() {
                CFRelease(props);
            }
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            VTCompressionSessionCompleteFrames(self.session, VtTime::invalid());
            VTCompressionSessionInvalidate(self.session);
            CFRelease(self.session as CFTypeRef);
            drop(Box::from_raw(self.sink as *mut Sink));
        }
    }
}

/// Callback VideoToolbox : convertit AVCC (longueurs sur 4 octets) en Annex-B.
extern "C" fn on_encoded(refcon: *mut c_void, _src: *mut c_void, status: OSStatus, _flags: u32, sb: CMSampleBufferRef) {
    if status != 0 || sb.is_null() {
        return;
    }
    let sink = unsafe { &*(refcon as *const Sink) };
    unsafe {
        let atts = CMSampleBufferGetSampleAttachmentsArray(sb, 0);
        let key = atts.is_null()
            || CFArrayGetCount(atts) == 0
            || CFDictionaryContainsKey(CFArrayGetValueAtIndex(atts, 0), kCMSampleAttachmentKey_NotSync as CFTypeRef) == 0;

        let bb = CMSampleBufferGetDataBuffer(sb);
        if bb.is_null() {
            return;
        }
        let len = CMBlockBufferGetDataLength(bb);
        let mut avcc = vec![0u8; len];
        if CMBlockBufferCopyDataBytes(bb, 0, len, avcc.as_mut_ptr() as *mut c_void) != 0 {
            return;
        }
        let mut out = Vec::with_capacity(len + 128);
        if key {
            let fd = CMSampleBufferGetFormatDescription(sb);
            let mut count = 0usize;
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, 0, std::ptr::null_mut(), std::ptr::null_mut(), &mut count, std::ptr::null_mut());
            for i in 0..count {
                let (mut ptr, mut size) = (std::ptr::null(), 0usize);
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, i, &mut ptr, &mut size, std::ptr::null_mut(), std::ptr::null_mut()) == 0 {
                    out.extend_from_slice(&[0, 0, 0, 1]);
                    out.extend_from_slice(std::slice::from_raw_parts(ptr, size));
                }
            }
        }
        let mut i = 0;
        while i + 4 <= len {
            let n = u32::from_be_bytes([avcc[i], avcc[i + 1], avcc[i + 2], avcc[i + 3]]) as usize;
            i += 4;
            if i + n > len {
                break;
            }
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(&avcc[i..i + n]);
            i += n;
        }
        // File pleine (réseau lent) : on jette l'image et on repart sur une image clé.
        if sink.tx.try_send(Bytes::from(out)).is_err() {
            sink.force_key.store(true, Ordering::Relaxed);
        }
    }
}

struct Output {
    enc: Arc<Encoder>,
}
impl SCStreamOutputTrait for Output {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        if !matches!(kind, SCStreamOutputType::Screen) {
            return;
        }
        if let Some(status) = sample.frame_status() {
            if !matches!(status, screencapturekit::cm::SCFrameStatus::Complete) {
                return;
            }
        }
        if let Some(pb) = sample.pixel_buffer() {
            self.enc.encode(Some(pb.as_ptr()));
        }
    }
}

/// Une capture en cours. S'arrête quand elle est détruite.
pub struct Capture {
    stream: SCStream,
    enc: Arc<Encoder>,
    alive: Arc<AtomicBool>,
    pub geometry: ScreenGeometry,
}

impl Capture {
    pub fn start(p: CaptureParams, tx: mpsc::Sender<Bytes>) -> Result<Self> {
        let content = SCShareableContent::get().map_err(|e| anyhow!("accès à l'écran refusé : {e:?}"))?;
        let main_id = unsafe { CGMainDisplayID() };
        let displays = content.displays();
        let display = displays
            .iter()
            .find(|d| d.display_id() == main_id)
            .or_else(|| displays.first())
            .ok_or_else(|| anyhow!("aucun écran trouvé"))?;

        // Résolution native (Retina = 2x les points), plafonnée à max_width, dimensions paires.
        let (pw, ph) = (display.width() as f64, display.height() as f64);
        let scale = ((p.max_width as f64) / (pw * 2.0)).min(1.0) * 2.0;
        let w = ((pw * scale) as u32) & !1;
        let h = ((ph * scale) as u32) & !1;

        let filter = SCContentFilter::create().with_display(display).with_excluding_windows(&[]).build().map_err(|e| anyhow!("filtre : {e:?}"))?;
        let config = SCStreamConfiguration::new()
            .with_width(w)
            .with_height(h)
            .with_pixel_format(PixelFormat::YCbCr_420v)
            .with_shows_cursor(true)
            .with_fps(p.fps)
            .with_queue_depth(4);

        let enc = Encoder::new(w as i32, h as i32, p, tx)?;
        let mut stream = SCStream::new(&filter, &config).map_err(|e| anyhow!("flux : {e:?}"))?;
        stream.add_output_handler(Output { enc: enc.clone() }, SCStreamOutputType::Screen).map_err(|e| anyhow!("sortie : {e:?}"))?;
        stream.start_capture().map_err(|e| anyhow!("démarrage de la capture : {e:?}"))?;

        // Écran immobile : ScreenCaptureKit n'envoie plus rien, on renvoie la dernière image
        // deux fois par seconde pour que la visionneuse récupère vite après une perte.
        let alive = Arc::new(AtomicBool::new(true));
        {
            let (enc, alive) = (enc.clone(), alive.clone());
            std::thread::spawn(move || {
                while alive.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(250));
                    let now = enc.start.elapsed().as_millis() as u64;
                    if now.saturating_sub(enc.last_encode_ms.load(Ordering::Relaxed)) >= 500 {
                        enc.encode(None);
                    }
                }
            });
        }

        Ok(Self { stream, enc, alive, geometry: ScreenGeometry { display_id: display.display_id(), width: w, height: h } })
    }

    pub fn request_keyframe(&self) {
        self.enc.request_keyframe();
        self.enc.encode(None);
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        let _ = self.stream.stop_capture();
    }
}
