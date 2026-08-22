/**
 * The site-wide concrete ground. Five tiles, cycled with the C key and
 * remembered in localStorage, drawn behind everything by body::before.
 */

const TEXTURES = [
  "/assets/textures/concrete-01.webp", // pale poured concrete
  "/assets/textures/concrete-02.webp", // board-formed concrete
  "/assets/textures/concrete-03.webp", // fine grit cement
  "/assets/textures/concrete-04.webp", // polished cement
  "/assets/textures/concrete-05.webp", // weathered slab
];
const TEXTURE_KEY = "makefaster.textureIndex";

function storedIndex() {
  var index = parseInt(localStorage.getItem(TEXTURE_KEY), 10);
  if (!Number.isInteger(index) || index < 0 || index >= TEXTURES.length) return 0;
  return index;
}

function applyTexture(i) {
  // Browsers resolve relative url()s in custom properties against the
  // stylesheet that consumes them, which would point inside css/ here, so the
  // value is made absolute first.
  var abs = new URL(TEXTURES[i], document.baseURI).href;
  document.documentElement.style.setProperty("--texture-image", 'url("' + abs + '")');
}

/** Apply the remembered texture and start listening for the C key. */
export function installTextureCycle() {
  var textureIndex = storedIndex();
  applyTexture(textureIndex);

  // Warm the cache so cycling is instant.
  TEXTURES.forEach(function (src) {
    var img = new Image();
    img.src = src;
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "c" && e.key !== "C") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;
    textureIndex = (textureIndex + 1) % TEXTURES.length;
    localStorage.setItem(TEXTURE_KEY, String(textureIndex));
    applyTexture(textureIndex);
  });
}
