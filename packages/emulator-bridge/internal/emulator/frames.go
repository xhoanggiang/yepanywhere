package emulator

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
)

// Frame holds a single screenshot from the emulator.
type Frame struct {
	Data      []byte // RGB888 pixels, bottom-up row order
	Width     int32
	Height    int32
	Seq       uint32
	Timestamp uint64 // microseconds from emulator
}

// FrameSource manages the screenshot stream and distributes frames to subscribers.
type FrameSource struct {
	client    *Client
	lastFrame atomic.Pointer[Frame]
	mu        sync.RWMutex
	subs      map[int]chan<- *Frame
	nextID    int
	cancel    context.CancelFunc
}

// NewFrameSource starts streaming screenshots and dispatching to subscribers.
func NewFrameSource(client *Client) *FrameSource {
	ctx, cancel := context.WithCancel(context.Background())
	fs := &FrameSource{
		client: client,
		subs:   make(map[int]chan<- *Frame),
		cancel: cancel,
	}
	go fs.run(ctx)
	return fs
}

// Subscribe returns a channel that receives frames.
// Slow consumers will have frames dropped (non-blocking send).
func (fs *FrameSource) Subscribe() (id int, ch <-chan *Frame) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	id = fs.nextID
	fs.nextID++
	c := make(chan *Frame, 2)
	fs.subs[id] = c
	return id, c
}

// Unsubscribe removes a subscriber.
func (fs *FrameSource) Unsubscribe(id int) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if ch, ok := fs.subs[id]; ok {
		close(ch)
		delete(fs.subs, id)
	}
}

// LastFrame returns the most recently received frame, or nil if none yet.
func (fs *FrameSource) LastFrame() *Frame {
	return fs.lastFrame.Load()
}

// Stop shuts down the frame source.
func (fs *FrameSource) Stop() {
	fs.cancel()
}

func (fs *FrameSource) run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}

		frames, err := fs.client.StreamScreenshots(ctx)
		if err != nil {
			log.Printf("frame source: stream error: %v", err)
			return
		}

		for frame := range frames {
			fs.lastFrame.Store(frame)
			fs.dispatch(frame)
		}

		// Stream ended (emulator disconnected or context canceled).
		if ctx.Err() != nil {
			return
		}
		log.Println("frame source: stream ended, reconnecting...")
	}
}

func (fs *FrameSource) dispatch(frame *Frame) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	for _, ch := range fs.subs {
		// Non-blocking send — drop frame for slow consumers.
		select {
		case ch <- frame:
		default:
		}
	}
}
