package stream

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/anthropics/yepanywhere/emulator-bridge/internal/emulator"
	"github.com/anthropics/yepanywhere/emulator-bridge/internal/encoder"
)

// SignalingHandler manages HTTP signaling for WebRTC sessions.
type SignalingHandler struct {
	mu          sync.Mutex
	session     *PeerSession
	pipeCancel  func()
	frameSource *emulator.FrameSource
	enc         *encoder.H264Encoder
	inputHandler *InputHandler
	stunServers []string
	targetW     int
	targetH     int
}

// NewSignalingHandler creates a new signaling handler.
func NewSignalingHandler(
	frameSource *emulator.FrameSource,
	enc *encoder.H264Encoder,
	inputHandler *InputHandler,
	stunServers []string,
	targetW, targetH int,
) *SignalingHandler {
	return &SignalingHandler{
		frameSource:  frameSource,
		enc:          enc,
		inputHandler: inputHandler,
		stunServers:  stunServers,
		targetW:      targetW,
		targetH:      targetH,
	}
}

type connectResponse struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

type answerRequest struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

// HandleConnect handles POST /api/connect — creates a new WebRTC session and returns the SDP offer.
func (sh *SignalingHandler) HandleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sh.mu.Lock()
	defer sh.mu.Unlock()

	// Close existing session if any.
	sh.closeSessionLocked()

	session, err := NewPeerSession(sh.stunServers, sh.inputHandler.HandleMessage)
	if err != nil {
		http.Error(w, fmt.Sprintf("creating session: %v", err), http.StatusInternalServerError)
		return
	}

	sdp, err := session.CreateOffer()
	if err != nil {
		session.Close()
		http.Error(w, fmt.Sprintf("creating offer: %v", err), http.StatusInternalServerError)
		return
	}

	sh.session = session

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(connectResponse{
		SDP:  sdp,
		Type: "offer",
	})
}

// HandleAnswer handles POST /api/answer — sets the SDP answer and starts the encoding pipeline.
func (sh *SignalingHandler) HandleAnswer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req answerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	sh.mu.Lock()
	defer sh.mu.Unlock()

	if sh.session == nil {
		http.Error(w, "no active session — call /api/connect first", http.StatusConflict)
		return
	}

	if err := sh.session.SetAnswer(req.SDP); err != nil {
		http.Error(w, fmt.Sprintf("setting answer: %v", err), http.StatusInternalServerError)
		return
	}

	// Start encoding pipeline.
	sh.startPipelineLocked()

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

func (sh *SignalingHandler) startPipelineLocked() {
	// Cancel any previous pipeline.
	if sh.pipeCancel != nil {
		sh.pipeCancel()
	}

	done := make(chan struct{})
	sh.pipeCancel = func() { close(done) }

	session := sh.session
	go sh.runPipeline(session, done)
}

func (sh *SignalingHandler) runPipeline(session *PeerSession, done chan struct{}) {
	id, frames := sh.frameSource.Subscribe()
	defer sh.frameSource.Unsubscribe(id)

	log.Println("pipeline: started")
	defer log.Println("pipeline: stopped")

	var lastTime time.Time

	for {
		select {
		case <-done:
			return
		case <-session.Done():
			return
		case frame, ok := <-frames:
			if !ok {
				return
			}

			// 1. Scale + flip.
			scaled := encoder.ScaleAndFlip(
				frame.Data,
				int(frame.Width), int(frame.Height),
				sh.targetW, sh.targetH,
			)

			// 2. Convert RGB -> I420.
			y, cb, cr := encoder.RGBToI420(scaled, sh.targetW, sh.targetH)

			// 3. Encode to h264.
			nals, err := sh.enc.Encode(y, cb, cr)
			if err != nil {
				log.Printf("pipeline: encode error: %v", err)
				continue
			}
			if nals == nil {
				continue
			}

			// 4. Write to WebRTC.
			now := time.Now()
			duration := time.Second / 30
			if !lastTime.IsZero() {
				duration = now.Sub(lastTime)
			}
			lastTime = now

			if err := session.WriteVideoSample(nals, duration); err != nil {
				log.Printf("pipeline: write error: %v", err)
				return
			}
		}
	}
}

func (sh *SignalingHandler) closeSessionLocked() {
	if sh.pipeCancel != nil {
		sh.pipeCancel()
		sh.pipeCancel = nil
	}
	if sh.session != nil {
		sh.session.Close()
		sh.session = nil
	}
}
