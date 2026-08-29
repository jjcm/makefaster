package favicon

// ICO is the format most of the web still answers /favicon.ico with, and the
// standard library has no decoder for it. It is a container: a directory of
// entries, each holding either a whole PNG or a bare Windows DIB (a BMP with no
// file header, stored upside down, with a 1-bit transparency mask stapled
// underneath the colour rows).
//
// This decodes the subset that favicons are actually written in — PNG payloads
// and uncompressed 1/4/8/24/32-bit DIBs — and refuses the rest rather than
// guessing. A refusal costs a row its icon, not its render: the board falls
// back to the site's initial.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"sort"
)

// The DIB compression schemes worth accepting: uncompressed, and the
// "bitfields" variant that 32-bit icons are sometimes tagged with while still
// being plain BGRA. Run-length encoded bitmaps are refused.
const (
	compressionRGB       = 0
	compressionBitfields = 3
)

const (
	icoHeaderBytes = 6
	icoEntryBytes  = 16
	dibHeaderMin   = 40
)

var pngMagic = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// looksLikeICO sniffs the container header: two reserved zero bytes, then type
// 1 (icon) or 2 (cursor), then a non-zero entry count.
func looksLikeICO(raw []byte) bool {
	if len(raw) < icoHeaderBytes {
		return false
	}
	if raw[0] != 0 || raw[1] != 0 || raw[3] != 0 {
		return false
	}
	if raw[2] != 1 && raw[2] != 2 {
		return false
	}
	return le16(raw, 4) > 0
}

func looksLikeBMP(raw []byte) bool {
	return len(raw) >= 14+dibHeaderMin && raw[0] == 'B' && raw[1] == 'M'
}

// icoEntry is one directory record: the declared dimensions plus where the
// payload lives.
type icoEntry struct {
	width  int
	height int
	bpp    int
	offset int
	length int
}

// decodeICO picks the best entry the file offers and decodes it, falling
// through to the next one when a payload turns out to be a variant this does
// not read.
func decodeICO(raw []byte) (image.Image, error) {
	count := int(le16(raw, 4))
	if len(raw) < icoHeaderBytes+count*icoEntryBytes {
		return nil, fmt.Errorf("%w: ico directory is truncated", ErrUnsupportedImage)
	}

	entries := make([]icoEntry, 0, count)
	for index := 0; index < count; index++ {
		at := icoHeaderBytes + index*icoEntryBytes
		entry := icoEntry{
			width:  icoEdge(raw[at]),
			height: icoEdge(raw[at+1]),
			bpp:    int(le16(raw, at+6)),
			length: int(le32(raw, at+8)),
			offset: int(le32(raw, at+12)),
		}
		if entry.offset <= 0 || entry.length <= 0 || entry.offset+entry.length > len(raw) {
			continue
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("%w: ico has no usable entries", ErrUnsupportedImage)
	}

	sort.SliceStable(entries, func(a, b int) bool { return entryScore(entries[a]) > entryScore(entries[b]) })

	var lastErr error
	for _, entry := range entries {
		payload := raw[entry.offset : entry.offset+entry.length]
		decoded, err := decodeICOPayload(payload)
		if err == nil {
			return decoded, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// entryScore ranks the directory. The smallest entry that is still at least
// Size wins, because it needs the least resampling to land on the served size;
// below that, bigger is better, and depth breaks ties between equal edges.
func entryScore(entry icoEntry) int {
	edge := entry.width
	if entry.height > edge {
		edge = entry.height
	}
	if edge >= Size {
		return 1_000_000 - edge*100 + entry.bpp
	}
	return edge*100 + entry.bpp
}

// icoEdge reads a directory dimension, where zero is the format's way of
// spelling 256.
func icoEdge(value byte) int {
	if value == 0 {
		return 256
	}
	return int(value)
}

func decodeICOPayload(payload []byte) (image.Image, error) {
	if bytes.HasPrefix(payload, pngMagic) {
		decoded, err := png.Decode(bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("%w: ico png payload: %v", ErrUnsupportedImage, err)
		}
		return decoded, nil
	}
	if len(payload) < dibHeaderMin {
		return nil, fmt.Errorf("%w: ico payload is too short to be a dib", ErrUnsupportedImage)
	}
	return decodeDIB(payload, true, -1)
}

// decodeBMP reads a standalone .bmp — the same DIB with a 14-byte file header
// in front of it and no transparency mask underneath.
func decodeBMP(raw []byte) (image.Image, error) {
	pixelOffset := int(le32(raw, 10))
	if pixelOffset <= 0 || pixelOffset >= len(raw) {
		pixelOffset = -1
	} else {
		pixelOffset -= 14
	}
	return decodeDIB(raw[14:], false, pixelOffset)
}

// decodeDIB decodes an uncompressed device-independent bitmap.
//
// iconMask says the header's height covers the colour rows *plus* a 1-bit AND
// mask below them, which is how ICO stores transparency for every depth that
// has no alpha channel of its own. pixelOffset is where the colour rows start
// relative to the DIB, or -1 for "straight after the header and palette", which
// is how ICO packs them.
func decodeDIB(data []byte, iconMask bool, pixelOffset int) (image.Image, error) {
	headerSize := int(le32(data, 0))
	if headerSize < dibHeaderMin || headerSize > len(data) {
		return nil, fmt.Errorf("%w: dib header size %d", ErrUnsupportedImage, headerSize)
	}

	width := int(int32(le32(data, 4)))
	height := int(int32(le32(data, 8)))
	bpp := int(le16(data, 14))
	compression := int(le32(data, 16))
	paletteCount := int(le32(data, 32))

	// A negative height means the rows are stored top-down, which only ever
	// happens in standalone BMPs.
	topDown := height < 0
	if topDown {
		height = -height
	}
	if iconMask {
		height /= 2
	}
	if width <= 0 || height <= 0 || width > maxSourceEdge || height > maxSourceEdge {
		return nil, fmt.Errorf("%w: dib is %dx%d", ErrUnsupportedImage, width, height)
	}
	if compression != compressionRGB && !(compression == compressionBitfields && bpp == 32) {
		return nil, fmt.Errorf("%w: dib compression %d at %d bpp", ErrUnsupportedImage, compression, bpp)
	}

	palette, paletteBytes, err := readPalette(data, headerSize, bpp, paletteCount, compression)
	if err != nil {
		return nil, err
	}
	if pixelOffset < 0 {
		pixelOffset = headerSize + paletteBytes
	}

	stride := ((width*bpp + 31) / 32) * 4
	if stride <= 0 || pixelOffset < 0 || pixelOffset+stride*height > len(data) {
		return nil, fmt.Errorf("%w: dib pixel data is truncated", ErrUnsupportedImage)
	}

	decoded, allAlphaZero := readDIBPixels(data[pixelOffset:], width, height, bpp, stride, topDown, palette)

	// A 32-bit icon whose alpha channel is entirely zero is not invisible, it
	// is an icon written before alpha was standard: those rely on the AND mask
	// exactly like the shallower depths do.
	if bpp == 32 && allAlphaZero {
		fillOpaque(decoded)
	}
	if iconMask && (bpp != 32 || allAlphaZero) {
		applyANDMask(decoded, data, pixelOffset+stride*height, width, height, topDown)
	}
	return decoded, nil
}

func readPalette(data []byte, headerSize, bpp, declared, compression int) ([]color.NRGBA, int, error) {
	// The three channel masks a BI_BITFIELDS header carries sit where a
	// palette would, and 32-bit icons have no palette to read.
	if bpp > 8 {
		if compression == compressionBitfields {
			return nil, 12, nil
		}
		return nil, 0, nil
	}
	count := declared
	if count <= 0 || count > 1<<bpp {
		count = 1 << bpp
	}
	size := count * 4
	if headerSize+size > len(data) {
		return nil, 0, fmt.Errorf("%w: dib palette is truncated", ErrUnsupportedImage)
	}
	palette := make([]color.NRGBA, count)
	for index := 0; index < count; index++ {
		at := headerSize + index*4
		palette[index] = color.NRGBA{R: data[at+2], G: data[at+1], B: data[at], A: 0xff}
	}
	return palette, size, nil
}

// readDIBPixels reads the colour rows. The second return reports that every
// alpha byte was zero, which only means anything at 32 bpp.
func readDIBPixels(pixels []byte, width, height, bpp, stride int, topDown bool, palette []color.NRGBA) (*image.NRGBA, bool) {
	out := image.NewNRGBA(image.Rect(0, 0, width, height))
	allAlphaZero := true

	for row := 0; row < height; row++ {
		y := height - 1 - row
		if topDown {
			y = row
		}
		line := pixels[row*stride : row*stride+stride]
		for x := 0; x < width; x++ {
			pixel := dibPixel(line, x, bpp, palette)
			if pixel.A != 0 {
				allAlphaZero = false
			}
			out.SetNRGBA(x, y, pixel)
		}
	}
	return out, allAlphaZero
}

func dibPixel(line []byte, x, bpp int, palette []color.NRGBA) color.NRGBA {
	switch bpp {
	case 32:
		at := x * 4
		return color.NRGBA{R: line[at+2], G: line[at+1], B: line[at], A: line[at+3]}
	case 24:
		at := x * 3
		return color.NRGBA{R: line[at+2], G: line[at+1], B: line[at], A: 0xff}
	case 8:
		return paletteAt(palette, int(line[x]))
	case 4:
		nibble := line[x/2]
		if x%2 == 0 {
			return paletteAt(palette, int(nibble>>4))
		}
		return paletteAt(palette, int(nibble&0x0f))
	case 1:
		bit := line[x/8] >> (7 - uint(x%8)) & 1
		return paletteAt(palette, int(bit))
	}
	return color.NRGBA{}
}

func paletteAt(palette []color.NRGBA, index int) color.NRGBA {
	if index < 0 || index >= len(palette) {
		return color.NRGBA{}
	}
	return palette[index]
}

func fillOpaque(target *image.NRGBA) {
	for offset := 3; offset < len(target.Pix); offset += 4 {
		target.Pix[offset] = 0xff
	}
}

// applyANDMask clears the pixels the icon's 1-bit mask marks transparent. A
// truncated or missing mask leaves the icon opaque, which is a better answer
// than refusing an icon that decoded fine.
func applyANDMask(target *image.NRGBA, data []byte, start, width, height int, topDown bool) {
	stride := ((width + 31) / 32) * 4
	if start < 0 || start+stride*height > len(data) {
		return
	}
	mask := data[start:]
	for row := 0; row < height; row++ {
		y := height - 1 - row
		if topDown {
			y = row
		}
		line := mask[row*stride : row*stride+stride]
		for x := 0; x < width; x++ {
			if line[x/8]>>(7-uint(x%8))&1 == 1 {
				target.SetNRGBA(x, y, color.NRGBA{})
			}
		}
	}
}

func le16(data []byte, at int) uint16 { return binary.LittleEndian.Uint16(data[at : at+2]) }
func le32(data []byte, at int) uint32 { return binary.LittleEndian.Uint32(data[at : at+4]) }
