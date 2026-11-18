//! Une session de contrôle : WebRTC (vidéo H.264 + canal de commandes) avec la visionneuse.

use crate::capture::{Capture, CaptureParams, ScreenGeometry};
use crate::input::{InputMsg, Injector};
use anyhow::{anyhow, Result};
use bytes::Bytes;
use rtc::interceptor::Registry;
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::{MediaEngine, MIME_TYPE_H264};
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::RTCIceServer;
use rtc::rtp_transceiver::rtp_sender::{RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Notify};
use webrtc::data_channel::DataChannelEvent;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::Track;
use webrtc::peer_connection::{PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState, RTCPeerConnectionState};

#[derive(Deserialize, Clone, Debug)]
pub struct IceServer {
    pub urls: Value,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

struct Handler {
    gathered: Arc<Notify>,
    ended: mpsc::UnboundedSender<()>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.gathered.notify_one();
        }
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed | RTCPeerConnectionState::Disconnected) {
            let _ = self.ended.send(());
        }
    }
}

/// Capture vivant sur son propre thread (les objets ScreenCaptureKit ne sont pas `Send`).
struct CaptureThread {
    stop: Option<std::sync::mpsc::Sender<()>>,
    keyframe: std::sync::mpsc::Sender<()>,
    geometry: ScreenGeometry,
}
impl CaptureThread {
    fn spawn(p: CaptureParams, tx: mpsc::Sender<Bytes>) -> Result<Self> {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (kf_tx, kf_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || match Capture::start(p, tx) {
            Ok(cap) => {
                let _ = ready_tx.send(Ok(cap.geometry));
                loop {
                    if stop_rx.try_recv().is_ok() || matches!(stop_rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Disconnected)) {
                        break;
                    }
                    if kf_rx.recv_timeout(Duration::from_millis(100)).is_ok() {
                        cap.request_keyframe();
                    }
                }
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        });
        let geometry = ready_rx.recv().map_err(|_| anyhow!("thread de capture interrompu"))??;
        Ok(Self { stop: Some(stop_tx), keyframe: kf_tx, geometry })
    }
}
impl Drop for CaptureThread {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }
}

/// Déroule une session complète. Se termine quand le PC se déconnecte ou sur `cancel`.
pub async fn run(
    sid: String,
    ice: Vec<IceServer>,
    params: CaptureParams,
    ws_out: mpsc::UnboundedSender<String>,
    mut signals: mpsc::UnboundedReceiver<Value>,
    cancel: oneshot::Receiver<()>,
) -> Result<()> {
    let (frame_tx, mut frame_rx) = mpsc::channel::<Bytes>(8);
    let capture = tokio::task::spawn_blocking(move || CaptureThread::spawn(params, frame_tx)).await??;

    let codec = RTCRtpCodec {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90000,
        channels: 0,
        sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f".to_owned(),
        rtcp_feedback: vec![],
    };
    let mut media = MediaEngine::default();
    media.register_codec(RTCRtpCodecParameters { rtp_codec: codec.clone(), payload_type: 102, ..Default::default() }, RtpCodecKind::Video)?;
    let registry = register_default_interceptors(Registry::new(), &mut media)?;

    let ice_servers = ice
        .iter()
        .map(|s| RTCIceServer {
            urls: match &s.urls {
                Value::String(u) => vec![u.clone()],
                Value::Array(a) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
                _ => vec![],
            },
            username: s.username.clone().unwrap_or_default(),
            credential: s.credential.clone().unwrap_or_default(),
            ..Default::default()
        })
        .collect();
    let config = RTCConfigurationBuilder::new().with_ice_servers(ice_servers).build();

    let gathered = Arc::new(Notify::new());
    let (ended_tx, mut ended_rx) = mpsc::unbounded_channel();
    let pc = PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_handler(Arc::new(Handler { gathered: gathered.clone(), ended: ended_tx.clone() }))
        .with_runtime(webrtc::runtime::default_runtime().ok_or_else(|| anyhow!("runtime"))?)
        .with_udp_addrs(vec!["0.0.0.0:0"])
        .build()
        .await?;

    let track = Arc::new(TrackLocalStaticSample::new(
        Instant::now(),
        MediaStreamTrack::new(
            "ecran".into(),
            "video".into(),
            "Écran du Mac".into(),
            RtpCodecKind::Video,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(rand::random::<u32>()), ..Default::default() },
                codec: codec.clone(),
                ..Default::default()
            }],
        ),
    )?);
    let sender = pc.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>).await?;
    let dc = pc.create_data_channel("input", None).await?;

    // Offre complète (ICE non-trickle : un seul aller-retour par le relais).
    let offer = pc.create_offer(None).await?;
    pc.set_local_description(offer).await?;
    let _ = tokio::time::timeout(Duration::from_secs(3), gathered.notified()).await;
    let local = pc.local_description().await.ok_or_else(|| anyhow!("pas de description locale"))?;
    ws_out.send(json!({ "t": "signal", "sid": sid, "data": { "sdp": local } }).to_string())?;

    let answer = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(v) = signals.recv().await {
            if let Some(sdp) = v.get("sdp") {
                return serde_json::from_value::<RTCSessionDescription>(sdp.clone()).ok();
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(|| anyhow!("pas de réponse de la visionneuse"))?;
    pc.set_remote_description(answer).await?;

    // Vidéo : envoie chaque image encodée dès qu'elle sort de l'encodeur.
    let payload_type = sender
        .get_parameters()
        .await?
        .rtp_parameters
        .codecs
        .first()
        .map(|c| c.payload_type)
        .ok_or_else(|| anyhow!("codec non négocié"))?;
    let ssrc = *track.ssrcs().await.first().ok_or_else(|| anyhow!("ssrc"))?;
    let video = tokio::spawn(async move {
        let mut last = Instant::now();
        while let Some(data) = frame_rx.recv().await {
            let now = Instant::now();
            let duration = now - last;
            last = now;
            let sample = Sample { data, duration, ..Sample::new(now) };
            if track.sample_writer(ssrc, payload_type).write_sample(&sample).await.is_err() {
                break;
            }
        }
    });

    // Commandes : souris/clavier injectés dans l'ordre d'arrivée.
    let geometry = capture.geometry;
    let keyframe = capture.keyframe.clone();
    let ended = ended_tx.clone();
    let input = tokio::spawn(async move {
        let mut injector = Injector::new(geometry.display_id);
        while let Some(ev) = dc.poll().await {
            match ev {
                DataChannelEvent::OnOpen => {
                    let _ = dc.send_text(&json!({ "k": "hello", "w": geometry.width, "h": geometry.height }).to_string()).await;
                    let _ = keyframe.send(());
                }
                DataChannelEvent::OnMessage(m) => match serde_json::from_slice::<InputMsg>(&m.data) {
                    Ok(InputMsg::KeyFrame) => {
                        let _ = keyframe.send(());
                    }
                    Ok(msg) => injector.handle(msg),
                    Err(_) => {}
                },
                DataChannelEvent::OnClose => break,
                _ => {}
            }
        }
        injector.release_all();
        let _ = ended.send(());
    });

    tokio::select! {
        _ = ended_rx.recv() => {}
        _ = cancel => {}
    }
    video.abort();
    input.abort();
    drop(capture);
    let _ = pc.close().await;
    Ok(())
}
