package favicon_test

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"testing"

	"makefaster/internal/favicon"
)

// solidPNG is a source icon: one colour, whatever size an origin felt like
// serving.
func solidPNG(t *testing.T, width, height int, fill color.NRGBA) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(img, img.Bounds(), &image.Uniform{fill}, image.Point{}, draw.Src)
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatalf("encode source png: %v", err)
	}
	return out.Bytes()
}

func decodePNG(t *testing.T, raw []byte) image.Image {
	t.Helper()
	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("the normalized bytes are not a png: %v", err)
	}
	return decoded
}

func assertColor(t *testing.T, img image.Image, x, y int, want color.NRGBA) {
	t.Helper()
	r, g, b, a := img.At(x, y).RGBA()
	got := color.NRGBA{R: uint8(r >> 8), G: uint8(g >> 8), B: uint8(b >> 8), A: uint8(a >> 8)}
	if got != want {
		t.Fatalf("pixel (%d,%d) is %+v, want %+v", x, y, got, want)
	}
}

var (
	red   = color.NRGBA{R: 0xff, A: 0xff}
	blue  = color.NRGBA{B: 0xff, A: 0xff}
	clear = color.NRGBA{}
)

// Whatever arrives, exactly one size and one format leaves: the page's
// `.favicon-box` is a fixed square and never has to reason about the original.
func TestNormalizeAlwaysProducesOneSizeAndFormat(t *testing.T) {
	for _, size := range []int{16, 32, 64, 128, 256} {
		normalized, err := favicon.Normalize(solidPNG(t, size, size, red))
		if err != nil {
			t.Fatalf("normalize a %dpx icon: %v", size, err)
		}
		bounds := decodePNG(t, normalized).Bounds()
		if bounds.Dx() != favicon.Size || bounds.Dy() != favicon.Size {
			t.Fatalf("a %dpx icon normalized to %dx%d, want %d square",
				size, bounds.Dx(), bounds.Dy(), favicon.Size)
		}
	}
}

func TestNormalizeAveragesADownscale(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 128, 128))
	draw.Draw(source, image.Rect(0, 0, 64, 128), &image.Uniform{red}, image.Point{}, draw.Src)
	draw.Draw(source, image.Rect(64, 0, 128, 128), &image.Uniform{blue}, image.Point{}, draw.Src)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatalf("encode source: %v", err)
	}

	normalized, err := favicon.Normalize(encoded.Bytes())
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	out := decodePNG(t, normalized)
	assertColor(t, out, 8, 32, red)
	assertColor(t, out, 56, 32, blue)
}

// A wide or tall icon is fitted, not stretched: the leftover is transparent, so
// the board draws the original proportions inside its square box.
func TestNormalizeFitsAndCentresANonSquareIcon(t *testing.T) {
	normalized, err := favicon.Normalize(solidPNG(t, 64, 32, red))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	out := decodePNG(t, normalized)
	assertColor(t, out, 32, 32, red)
	assertColor(t, out, 32, 2, clear)
	assertColor(t, out, 32, 61, clear)
}

// A JPEG or GIF favicon is as valid as a PNG one, and comes out as the same
// PNG either way.
func TestNormalizeReadsTheOtherStandardFormats(t *testing.T) {
	gif := []byte{
		'G', 'I', 'F', '8', '9', 'a', 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
		0xff, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
		0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
	}
	normalized, err := favicon.Normalize(gif)
	if err != nil {
		t.Fatalf("normalize a gif: %v", err)
	}
	assertColor(t, decodePNG(t, normalized), 32, 32, red)
}

// The formats this server cannot rasterize — an SVG favicon, a WebP — and the
// HTML error page an origin serves with a 200 all land here. The caller turns
// that into the board's letter fallback rather than a broken image.
func TestNormalizeRefusesWhatItCannotRead(t *testing.T) {
	cases := map[string][]byte{
		"an svg favicon":  []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>`),
		"an html page":    []byte("<!DOCTYPE html><title>404</title>"),
		"empty bytes":     {},
		"a truncated png": solidPNG(t, 16, 16, red)[:20],
	}
	for name, raw := range cases {
		if _, err := favicon.Normalize(raw); err == nil {
			t.Fatalf("normalizing %s should have failed", name)
		}
	}
}

// ---------------------------------------------------------------- ICO

// icoWithPayload wraps one payload in an ICO directory, which is how a real
// /favicon.ico is put together.
func icoWithPayload(width, height, bpp int, payload []byte) []byte {
	out := make([]byte, 0, 22+len(payload))
	out = append(out, 0, 0, 1, 0, 1, 0) // reserved, type 1 (icon), one entry
	out = append(out, byte(width%256), byte(height%256), 0, 0)
	out = binary.LittleEndian.AppendUint16(out, 1)
	out = binary.LittleEndian.AppendUint16(out, uint16(bpp))
	out = binary.LittleEndian.AppendUint32(out, uint32(len(payload)))
	out = binary.LittleEndian.AppendUint32(out, 22)
	return append(out, payload...)
}

// dibPayload is the other thing an ICO entry can hold: a headerless BMP, stored
// bottom-up, with its declared height covering the colour rows plus a 1-bit
// transparency mask underneath.
func dibPayload(edge int, fill color.NRGBA) []byte {
	header := make([]byte, 0, 40)
	header = binary.LittleEndian.AppendUint32(header, 40)
	header = binary.LittleEndian.AppendUint32(header, uint32(edge))
	header = binary.LittleEndian.AppendUint32(header, uint32(edge*2))
	header = binary.LittleEndian.AppendUint16(header, 1)
	header = binary.LittleEndian.AppendUint16(header, 32)
	header = append(header, make([]byte, 24)...) // compression 0 and the sizes nobody reads

	pixels := make([]byte, 0, edge*edge*4)
	for row := 0; row < edge; row++ {
		for column := 0; column < edge; column++ {
			pixels = append(pixels, fill.B, fill.G, fill.R, fill.A)
		}
	}
	mask := make([]byte, ((edge+31)/32)*4*edge)
	return append(append(header, pixels...), mask...)
}

func TestNormalizeReadsAnICOWithAPNGPayload(t *testing.T) {
	normalized, err := favicon.Normalize(icoWithPayload(32, 32, 32, solidPNG(t, 32, 32, blue)))
	if err != nil {
		t.Fatalf("normalize an ico: %v", err)
	}
	out := decodePNG(t, normalized)
	if out.Bounds().Dx() != favicon.Size {
		t.Fatalf("normalized to %d px, want %d", out.Bounds().Dx(), favicon.Size)
	}
	assertColor(t, out, 32, 32, blue)
}

func TestNormalizeReadsAnICOWithABitmapPayload(t *testing.T) {
	normalized, err := favicon.Normalize(icoWithPayload(16, 16, 32, dibPayload(16, red)))
	if err != nil {
		t.Fatalf("normalize a bitmap ico: %v", err)
	}
	assertColor(t, decodePNG(t, normalized), 32, 32, red)
}

// The directory can hold several sizes of the same icon. The one that needs the
// least resampling to reach the served size should win, and a payload this
// cannot read must not cost the file its other entries.
func TestNormalizePrefersTheUsableEntryClosestToTheServedSize(t *testing.T) {
	small := solidPNG(t, 16, 16, red)
	right := solidPNG(t, 64, 64, blue)

	out := make([]byte, 0)
	out = append(out, 0, 0, 1, 0, 3, 0)
	offsets := []int{6 + 3*16, 6 + 3*16 + len(small), 6 + 3*16 + len(small) + len(right)}
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>`)
	entries := []struct {
		edge   int
		length int
		offset int
	}{
		{16, len(small), offsets[0]},
		{64, len(right), offsets[1]},
		{0, len(svg), offsets[2]}, // 0 means 256 px — the biggest, and unreadable
	}
	for _, entry := range entries {
		out = append(out, byte(entry.edge), byte(entry.edge), 0, 0)
		out = binary.LittleEndian.AppendUint16(out, 1)
		out = binary.LittleEndian.AppendUint16(out, 32)
		out = binary.LittleEndian.AppendUint32(out, uint32(entry.length))
		out = binary.LittleEndian.AppendUint32(out, uint32(entry.offset))
	}
	out = append(out, small...)
	out = append(out, right...)
	out = append(out, svg...)

	normalized, err := favicon.Normalize(out)
	if err != nil {
		t.Fatalf("normalize a multi-size ico: %v", err)
	}
	// The 64px entry, not the 256px one it cannot read and not the 16px one.
	assertColor(t, decodePNG(t, normalized), 32, 32, blue)
}

func TestNormalizeRefusesABrokenICO(t *testing.T) {
	cases := map[string][]byte{
		"a truncated directory":                      {0, 0, 1, 0, 4, 0, 0, 0},
		"an entry pointing past the end of the file": icoWithPayload(16, 16, 32, nil),
		"a payload that is neither png nor dib":      icoWithPayload(16, 16, 32, []byte("not an icon at all")),
	}
	for name, raw := range cases {
		if _, err := favicon.Normalize(raw); err == nil {
			t.Fatalf("normalizing %s should have failed", name)
		}
	}
}
