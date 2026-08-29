package favicon

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"

	// The formats a favicon actually arrives in. ICO and the bare DIBs inside
	// it are decoded by ico.go, because the standard library has no decoder
	// for the container every /favicon.ico in the wild still uses.
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
)

// Size is the edge of the square every icon is normalized to, in pixels.
//
// The board draws it into a 28px `.favicon-box` at 26px (css/style.css), so 64
// is the next power of two that still has pixels to spare on a 2x display and
// costs a couple of kilobytes. Everything the server stores is exactly this
// size in exactly one format, so the page never has to care what the origin
// served.
const Size = 64

// maxSourceEdge rejects an image nobody would use as a favicon before it is
// resampled. A 1 MB body can still decode to something enormous, and this is
// the cheap wall in front of that.
const maxSourceEdge = 4096

// ErrUnsupportedImage means the bytes were fetched fine and are not an image
// this server can turn into a PNG — an SVG favicon, a WebP, or an HTML error
// page served with a 200. The row keeps its letter fallback.
var ErrUnsupportedImage = errors.New("not an image this server can normalize")

// Normalize turns whatever an origin served into the one shape this server
// publishes: a Size x Size PNG, the icon scaled to fit and centred on
// transparency so a wide or tall source is not distorted.
func Normalize(raw []byte) ([]byte, error) {
	source, err := decode(raw)
	if err != nil {
		return nil, err
	}
	bounds := source.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return nil, fmt.Errorf("%w: zero-sized image", ErrUnsupportedImage)
	}
	if bounds.Dx() > maxSourceEdge || bounds.Dy() > maxSourceEdge {
		return nil, fmt.Errorf("%w: %dx%d is larger than %d px", ErrUnsupportedImage,
			bounds.Dx(), bounds.Dy(), maxSourceEdge)
	}

	var out bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestCompression}
	if err := encoder.Encode(&out, fitSquare(source, Size)); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return out.Bytes(), nil
}

// decode reads the image formats a favicon URL answers with. ICO is sniffed
// rather than registered, because its header (two zero bytes then a type) is
// too weak a signature to hand to image.RegisterFormat.
func decode(raw []byte) (image.Image, error) {
	if looksLikeICO(raw) {
		return decodeICO(raw)
	}
	if looksLikeBMP(raw) {
		return decodeBMP(raw)
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnsupportedImage, err)
	}
	return decoded, nil
}

// fitSquare scales src to fit a size x size canvas, keeping its aspect ratio
// and centring what is left over.
//
// Downscaling averages every source pixel that falls inside a destination
// pixel, which is what keeps a 256px icon from turning into aliased confetti at
// 64px. Upscaling lands on nearest-neighbour, and that is the right answer for
// the 16px icons this mostly sees: a 4x nearest scale stays crisp where a
// smooth filter would only add blur.
func fitSquare(src image.Image, size int) *image.NRGBA {
	bounds := src.Bounds()
	scale := math.Min(float64(size)/float64(bounds.Dx()), float64(size)/float64(bounds.Dy()))
	width := clampEdge(int(math.Round(float64(bounds.Dx())*scale)), size)
	height := clampEdge(int(math.Round(float64(bounds.Dy())*scale)), size)

	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	offsetX, offsetY := (size-width)/2, (size-height)/2
	stepX := float64(bounds.Dx()) / float64(width)
	stepY := float64(bounds.Dy()) / float64(height)

	for y := 0; y < height; y++ {
		y0, y1 := sourceSpan(bounds.Min.Y, bounds.Max.Y, y, stepY)
		for x := 0; x < width; x++ {
			x0, x1 := sourceSpan(bounds.Min.X, bounds.Max.X, x, stepX)
			dst.SetNRGBA(offsetX+x, offsetY+y, averageArea(src, x0, x1, y0, y1))
		}
	}
	return dst
}

// sourceSpan is the half-open source range a destination pixel covers, always
// at least one pixel wide so an upscale samples rather than averaging nothing.
func sourceSpan(min, max, index int, step float64) (int, int) {
	start := min + int(float64(index)*step)
	end := min + int(math.Ceil(float64(index+1)*step))
	if end <= start {
		end = start + 1
	}
	if start >= max {
		start = max - 1
	}
	if end > max {
		end = max
	}
	return start, end
}

// averageArea averages a rectangle of source pixels.
//
// The average is taken in alpha-premultiplied space — which is what
// color.Color#RGBA already hands over — because averaging straight colour
// alongside alpha is how a transparent icon picks up a dark halo. The result is
// un-premultiplied once, at the end.
func averageArea(src image.Image, x0, x1, y0, y1 int) color.NRGBA {
	var sumR, sumG, sumB, sumA uint64
	count := uint64((x1 - x0) * (y1 - y0))
	if count == 0 {
		return color.NRGBA{}
	}
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			r, g, b, a := src.At(x, y).RGBA()
			sumR += uint64(r)
			sumG += uint64(g)
			sumB += uint64(b)
			sumA += uint64(a)
		}
	}
	alpha := sumA / count
	if alpha == 0 {
		return color.NRGBA{}
	}
	return color.NRGBA{
		R: unpremultiply(sumR/count, alpha),
		G: unpremultiply(sumG/count, alpha),
		B: unpremultiply(sumB/count, alpha),
		A: uint8(alpha >> 8),
	}
}

func unpremultiply(channel, alpha uint64) uint8 {
	value := channel * 0xffff / alpha
	if value > 0xffff {
		value = 0xffff
	}
	return uint8(value >> 8)
}

func clampEdge(value, max int) int {
	if value < 1 {
		return 1
	}
	if value > max {
		return max
	}
	return value
}
