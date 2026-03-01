package encoder

// RGBToI420 converts a top-down RGB888 buffer to I420 (YUV 4:2:0) planar format.
// width and height must be even. Returns Y, Cb (U), Cr (V) as slices into a single allocation.
func RGBToI420(rgb []byte, width, height int) (y, cb, cr []byte) {
	ySize := width * height
	cSize := (width / 2) * (height / 2)
	buf := make([]byte, ySize+cSize+cSize)

	y = buf[:ySize]
	cb = buf[ySize : ySize+cSize]
	cr = buf[ySize+cSize:]

	cStride := width / 2

	for row := 0; row < height; row++ {
		rgbRowOffset := row * width * 3
		yRowOffset := row * width

		for col := 0; col < width; col++ {
			ri := rgbRowOffset + col*3
			r := int(rgb[ri])
			g := int(rgb[ri+1])
			b := int(rgb[ri+2])

			// BT.601 with fixed-point arithmetic.
			yVal := (77*r + 150*g + 29*b + 128) >> 8
			y[yRowOffset+col] = uint8(yVal)

			// Subsample U/V: only compute for top-left pixel of each 2x2 block.
			if row%2 == 0 && col%2 == 0 {
				ci := (row/2)*cStride + col/2
				uVal := ((-43*r - 85*g + 128*b + 128) >> 8) + 128
				vVal := ((128*r - 107*g - 21*b + 128) >> 8) + 128
				if uVal < 0 {
					uVal = 0
				} else if uVal > 255 {
					uVal = 255
				}
				if vVal < 0 {
					vVal = 0
				} else if vVal > 255 {
					vVal = 255
				}
				cb[ci] = uint8(uVal)
				cr[ci] = uint8(vVal)
			}
		}
	}

	return
}
