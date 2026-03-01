package stream

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// PeerSession represents one WebRTC connection to a browser.
type PeerSession struct {
	pc          *webrtc.PeerConnection
	videoTrack  *webrtc.TrackLocalStaticSample
	dataChannel *webrtc.DataChannel
	onInput     func(msg []byte)
	closed      chan struct{}
}

// NewPeerSession creates a PeerConnection with an h264 video track and a "control" DataChannel.
func NewPeerSession(stunServers []string, onInput func(msg []byte)) (*PeerSession, error) {
	iceServers := []webrtc.ICEServer{}
	if len(stunServers) > 0 {
		iceServers = append(iceServers, webrtc.ICEServer{URLs: stunServers})
	}

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: iceServers,
	})
	if err != nil {
		return nil, fmt.Errorf("creating peer connection: %w", err)
	}

	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
		"video", "emulator",
	)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("creating video track: %w", err)
	}

	if _, err := pc.AddTrack(videoTrack); err != nil {
		pc.Close()
		return nil, fmt.Errorf("adding video track: %w", err)
	}

	dc, err := pc.CreateDataChannel("control", nil)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("creating data channel: %w", err)
	}

	ps := &PeerSession{
		pc:          pc,
		videoTrack:  videoTrack,
		dataChannel: dc,
		onInput:     onInput,
		closed:      make(chan struct{}),
	}

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if ps.onInput != nil {
			ps.onInput(msg.Data)
		}
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("ICE connection state: %s", state.String())
		if state == webrtc.ICEConnectionStateFailed ||
			state == webrtc.ICEConnectionStateDisconnected ||
			state == webrtc.ICEConnectionStateClosed {
			select {
			case <-ps.closed:
			default:
				close(ps.closed)
			}
		}
	})

	return ps, nil
}

// CreateOffer creates an SDP offer and blocks until ICE gathering is complete.
// Returns the SDP with all candidates embedded.
func (ps *PeerSession) CreateOffer() (string, error) {
	offer, err := ps.pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("creating offer: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(ps.pc)

	if err := ps.pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("setting local description: %w", err)
	}

	// Wait for ICE gathering with timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	select {
	case <-gatherComplete:
	case <-ctx.Done():
		return "", fmt.Errorf("ICE gathering timed out")
	}

	return ps.pc.LocalDescription().SDP, nil
}

// SetAnswer sets the remote SDP answer from the browser.
func (ps *PeerSession) SetAnswer(sdp string) error {
	return ps.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	})
}

// WriteVideoSample sends h264 NAL data to the video track.
func (ps *PeerSession) WriteVideoSample(data []byte, duration time.Duration) error {
	return ps.videoTrack.WriteSample(media.Sample{
		Data:     data,
		Duration: duration,
	})
}

// Close tears down the PeerConnection.
func (ps *PeerSession) Close() error {
	select {
	case <-ps.closed:
	default:
		close(ps.closed)
	}
	return ps.pc.Close()
}

// Done returns a channel that is closed when the peer disconnects.
func (ps *PeerSession) Done() <-chan struct{} {
	return ps.closed
}
